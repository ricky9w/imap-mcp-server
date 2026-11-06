import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServeApp } from '../src/http/serve.js';
import { configuredAccess } from '../src/http/access.js';
import { TokenStore } from '../src/services/token-store.js';
import { AuditLog } from '../src/services/audit-log.js';

const issuer = 'https://test-team.cloudflareaccess.com';
const audience = 'mail-mcp-audience';
const user = { type: 'app', email: 'Reader@example.com', sub: 'user-1' };
const admin = { authorization: 'Bearer test-admin-with-enough-characters' };
const keys = await generateKeyPair('RS256');

function sign(claims = {}, key = keys.privateKey) {
  return new SignJWT({ ...user, iss: issuer, aud: [audience], exp: Math.floor(Date.now() / 1000) + 600, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(key);
}

describe('Cloudflare Access /mcp', () => {
  let dir: string;
  let file: string;
  let server: Server;
  let base: string;
  let store: TokenStore;
  let audit: AuditLog;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'imap-access-'));
    file = join(dir, 'certs.json');
    await writeFile(file, JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'test-key' }] }));
    vi.stubEnv('IMAP_MCP_ACCESS_TEAM_DOMAIN', 'test-team.cloudflareaccess.com');
    vi.stubEnv('IMAP_MCP_ACCESS_AUD', audience);
    vi.stubEnv('IMAP_MCP_ACCESS_JWKS_FILE', file);
    vi.stubEnv('IMAP_MCP_WIZARD_TOKEN', admin.authorization.slice(7));
    store = new TokenStore(join(dir, 'grants.json'));
    audit = new AuditLog(join(dir, 'audit.log'));
    const services = { imapService: {}, accountManager: {}, smtpService: { sendEmail: vi.fn() }, spamService: {} };
    const app = createServeApp(services as any, { host: '127.0.0.1', port: 0, tokenStore: store, auditLog: audit });
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await store.flush();
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function post(path: string, body: unknown, headers: Record<string, string>, method = 'POST') {
    return fetch(base + path, {
      method, headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }
  const list = (headers: Record<string, string>) => post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers);

  it('uses only the verified login’s grant, with live edits, revocation and separate admin auth', async () => {
    const headers = { 'cf-access-jwt-assertion': await sign(), authorization: 'Bearer opaque-client-token' };
    expect((await list(headers)).status).toBe(403);
    expect((await fetch(base + '/api/tokens', { headers })).status).toBe(401);
    const body = { name: 'Reader', accessEmail: 'READER@example.com', tools: ['imap_search_emails'] };
    const created = await post('/api/tokens', body, admin);
    expect(created.status).toBe(201);
    const result = await created.json();
    expect(result.secret).toBeUndefined();
    expect(new TokenStore(join(dir, 'grants.json')).forAccessEmail('reader@example.com')?.id).toBe(result.token.id);
    expect((await post('/api/tokens', body, admin)).status).toBe(409);
    const names = async () => (await (await list(headers)).json()).result.tools.map((tool: { name: string }) => tool.name);
    expect(await names()).toEqual(['imap_search_emails']);
    await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'imap_send_email', arguments: {} } }, headers);
    expect(audit.query({ tokenId: result.token.id, tool: 'imap_send_email' })[0]?.outcome).toBe('denied');
    const grant = '/api/tokens/' + result.token.id;
    expect((await post(grant, { tools: ['imap_mark_as_read'] }, admin, 'PATCH')).status).toBe(200);
    expect(await names()).toEqual(['imap_mark_as_read']);
    expect((await post(grant + '/revoke', {}, admin)).status).toBe(200);
    expect((await list(headers)).status).toBe(403);
  });

  it('requires both the Access service assertion and the script’s original bearer', async () => {
    const { token } = await store.create('script', ['imap_search_emails']);
    const bearer = { authorization: 'Bearer ' + token };
    const service = { 'cf-access-jwt-assertion': await sign({ email: undefined, sub: '', common_name: 'script-client-id' }) };
    expect((await list(bearer)).status).toBe(401);
    expect((await list(service)).status).toBe(401);
    expect((await list({ ...bearer, ...service })).status).toBe(200);
  });

  it('rejects spoofed headers, another app, wrong issuer, expired and forged assertions', async () => {
    const { token } = await store.create('agent', ['imap_list_folders']);
    const bearer = { authorization: 'Bearer ' + token };
    expect((await list({ ...bearer, 'cf-access-authenticated-user-email': user.email })).status).toBe(401);
    const wrongKey = await generateKeyPair('RS256');
    for (const assertion of [await sign({ aud: 'admin-audience' }), await sign({ iss: 'https://other.example' }),
      await sign({ exp: 1 }), await sign({ exp: undefined }), await sign({ type: 'org' }), await sign({}, wrongKey.privateKey)]) {
      expect((await list({ ...bearer, 'cf-access-jwt-assertion': assertion })).status).toBe(401);
    }
  });

  it('requires all Access settings and reloads refreshed signing keys', async () => {
    expect(configuredAccess({})).toBeUndefined();
    expect(() => configuredAccess({ IMAP_MCP_ACCESS_AUD: audience })).toThrow();
    const verify = configuredAccess(process.env)!;
    const assertion = await sign();
    expect(await verify(assertion)).toMatchObject({ email: 'reader@example.com' });
    const stale = new Date(Date.now() - 2 * 86400000);
    await utimes(file, stale, stale);
    expect(await verify(assertion)).toBeUndefined();
    const rotated = await generateKeyPair('RS256');
    await writeFile(file, JSON.stringify({ keys: [{ ...await exportJWK(rotated.publicKey), kid: 'test-key' }] }));
    expect(await verify(assertion)).toBeUndefined();
    expect(await verify(await sign({}, rotated.privateKey))).toMatchObject({ email: 'reader@example.com' });
  });
});
