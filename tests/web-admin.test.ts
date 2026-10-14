import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import { promises as fsp, readFileSync, statSync } from 'fs';
import path from 'path';
import os from 'os';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { WebUIServer, adminTokenFile } from '../src/web/server.js';
import { TokenStore } from '../src/services/token-store.js';
import { AuditLog } from '../src/services/audit-log.js';
import { collectToolDefinitions } from '../src/tools/registry.js';
import { toolCatalog } from '../src/tools/policy.js';

// The wizard in admin mode (the backend `serve` mounts): admin token always
// required, token and audit API, account changes invalidate cached connections.
const ADMIN = 'admin-token-0123456789';

const imapService = { disconnect: vi.fn(async () => {}) };
const smtpService = { disconnect: vi.fn() };
const accountManager = {
  getAllAccounts: () => [],
  getAccount: () => undefined,
  addAccount: async (account: Record<string, unknown>) => ({ ...account, id: 'new-acc' }),
  updateAccount: async (id: string, updates: Record<string, unknown>) => ({ id, name: 'Work', ...updates }),
  removeAccount: async () => {},
};
const catalog = toolCatalog(collectToolDefinitions({ imapService: {}, accountManager: {}, smtpService: {}, spamService: {} } as any));

let tmpHome: string;
let prevHome: string | undefined;
let tokenStore: TokenStore;
let auditLog: AuditLog;
let httpServer: Server;
let port: number;

const adminServer = (extra: Record<string, unknown> = {}) =>
  new WebUIServer(0, {
    accountManager: accountManager as any,
    imapService: imapService as any,
    smtpService: smtpService as any,
    bindHost: '127.0.0.1',
    admin: { tokenStore, auditLog, catalog, allowedOrigins: ['https://admin.example.com'] },
    ...extra,
  });

function request(opts: { method?: string; path: string; headers?: Record<string, string>; body?: unknown; json?: boolean; targetPort?: number }) {
  const data = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.json !== false && (data !== undefined || ['POST', 'PUT', 'PATCH'].includes(opts.method ?? ''))) {
    headers['content-type'] ??= 'application/json';
  }
  if (data !== undefined) headers['content-length'] = String(Buffer.byteLength(data));
  return new Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders; json: () => any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: opts.targetPort ?? port, method: opts.method ?? 'GET', path: opts.path, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

const asAdmin = (opts: Parameters<typeof request>[0]) =>
  request({ ...opts, headers: { authorization: `Bearer ${ADMIN}`, ...(opts.headers ?? {}) } });

beforeAll(async () => {
  prevHome = process.env.HOME;
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'imap-mcp-admin-'));
  process.env.HOME = tmpHome;
  tokenStore = new TokenStore(path.join(tmpHome, 'tokens.json'));
  auditLog = new AuditLog(path.join(tmpHome, 'audit.log'));
  await new Promise<void>((resolve) => {
    httpServer = adminServer({ accessToken: ADMIN }).getApp().listen(0, '127.0.0.1', () => resolve());
  });
  port = (httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  httpServer?.close();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

beforeEach(() => vi.clearAllMocks());

describe('admin mode authentication', () => {
  it('requires the admin token even on loopback', async () => {
    expect((await request({ path: '/api/tokens' })).status).toBe(401);
    expect((await request({ path: '/' })).status).toBe(401);
    expect((await asAdmin({ path: '/api/tokens' })).status).toBe(200);
  });

  it('does not accept an agent token as the admin token', async () => {
    const { token } = await tokenStore.create('agent', ['imap_search_emails']);
    expect((await request({ path: '/api/tokens', headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('generates, persists and reuses an admin token without printing it', async () => {
    vi.stubEnv('IMAP_MCP_WIZARD_TOKEN', '');
    const output: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => { output.push(args.join(' ')); });
    }
    try {
      const first = adminServer();
      const token = readFileSync(adminTokenFile(), 'utf-8').trim();
      expect(token.length).toBeGreaterThanOrEqual(16);
      if (process.platform !== 'win32') {
        expect(statSync(adminTokenFile()).mode & 0o777).toBe(0o600);
      }
      expect((first as any).accessToken).toBe(token);
      expect((adminServer() as any).accessToken).toBe(token);
      expect(first.getAccessUrl()).not.toContain(token);
      expect(output.join('\n')).not.toContain(token);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  it('takes IMAP_MCP_WIZARD_TOKEN, but never a short one or an agent token', () => {
    vi.stubEnv('IMAP_MCP_WIZARD_TOKEN', 'from-env-0123456789');
    expect((adminServer() as any).accessToken).toBe('from-env-0123456789');
    vi.stubEnv('IMAP_MCP_WIZARD_TOKEN', 'short');
    expect(() => adminServer()).toThrow(/at least 16/);
    vi.stubEnv('IMAP_MCP_WIZARD_TOKEN', `imcp_${'a'.repeat(10)}_${'b'.repeat(43)}`);
    expect(() => adminServer()).toThrow(/agent token/);
    vi.unstubAllEnvs();
  });

  it('refuses other origins, accepts same-origin and the configured ones', async () => {
    expect((await asAdmin({ path: '/api/tokens', headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect((await asAdmin({ path: '/api/tokens', headers: { origin: `http://127.0.0.1:${port}` } })).status).toBe(200);
    expect((await asAdmin({ path: '/api/tokens', headers: { origin: 'https://admin.example.com' } })).status).toBe(200);
  });

  it('marks the session cookie Secure behind a trusted HTTPS proxy', async () => {
    const wizard = adminServer({ accessToken: ADMIN });
    wizard.getApp().set('trust proxy', 'loopback');
    const server = await new Promise<Server>((resolve) => {
      const s = wizard.getApp().listen(0, '127.0.0.1', () => resolve(s));
    });
    const targetPort = (server.address() as AddressInfo).port;
    const plain = await request({ targetPort, path: `/?token=${ADMIN}` });
    const proxied = await request({ targetPort, path: `/?token=${ADMIN}`, headers: { 'x-forwarded-proto': 'https' } });
    server.close();

    expect(String(plain.headers['set-cookie'])).not.toContain('Secure');
    expect(String(proxied.headers['set-cookie'])).toContain('; Secure');
    expect(String(proxied.headers['set-cookie'])).toContain('HttpOnly; SameSite=Strict');
  });

  it('sends the security headers', async () => {
    const res = await asAdmin({ path: '/api/tokens' });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('requires JSON for state-changing API calls', async () => {
    const res = await asAdmin({ method: 'POST', path: '/api/tokens', headers: { 'content-type': 'text/plain' }, body: { name: 'x', preset: 'readonly' } });
    expect(res.status).toBe(415);
  });
});

describe('admin token API', () => {
  it('serves the catalog without the admin group', async () => {
    const body = (await asAdmin({ path: '/api/tools/catalog' })).json();
    expect(body.tools.map((t: any) => t.name)).not.toContain('imap_update_account');
    expect(body.presets.read_markread).toHaveLength(16);
  });

  it('creates a token from a preset and returns the secret only once', async () => {
    const created = await asAdmin({ method: 'POST', path: '/api/tokens', body: { name: 'laptop', preset: 'read_markread' } });
    expect(created.status).toBe(201);
    const { token, secret } = created.json();
    expect(secret).toMatch(/^imcp_[a-z2-7]{10}_/);
    expect(token.tools).toHaveLength(16);
    expect(token).not.toHaveProperty('hash');
    expect(tokenStore.verify(secret)?.id).toBe(token.id);

    const listed = await asAdmin({ path: '/api/tokens' });
    expect(listed.text).not.toContain(secret.slice(-43));
    expect(listed.text).not.toContain('"hash"');
    expect(listed.json().find((t: any) => t.id === token.id)).toMatchObject({ name: 'laptop' });
    expect(readFileSync(path.join(tmpHome, 'audit.log'), 'utf-8')).not.toContain(secret);
  });

  it('refuses admin-group and unknown tools, bad presets and empty grants with 400', async () => {
    const create = (body: unknown) => asAdmin({ method: 'POST', path: '/api/tokens', body });
    expect((await create({ name: 'x', tools: ['imap_search_emails', 'imap_update_account'] })).json().error).toMatch(/imap_update_account/);
    expect((await create({ name: 'x', tools: ['imap_disconnect'] })).status).toBe(400);
    expect((await create({ name: 'x', tools: ['imap_does_not_exist'] })).status).toBe(400);
    expect((await create({ name: 'x', preset: 'toString' })).status).toBe(400);
    expect((await create({ name: 'x', tools: [] })).status).toBe(400);
    expect((await create({ tools: ['imap_search_emails'] })).status).toBe(400);
  });

  it('updates and revokes tokens', async () => {
    const { token } = (await asAdmin({ method: 'POST', path: '/api/tokens', body: { name: 'desk', tools: ['imap_search_emails'] } })).json();

    const updated = await asAdmin({ method: 'PATCH', path: `/api/tokens/${token.id}`, body: { name: 'desk 2', tools: ['imap_get_email'] } });
    expect(updated.json().token).toMatchObject({ name: 'desk 2', tools: ['imap_get_email'] });
    expect((await asAdmin({ method: 'PATCH', path: `/api/tokens/${token.id}`, body: { tools: ['imap_add_account'] } })).status).toBe(400);
    expect((await asAdmin({ method: 'PATCH', path: '/api/tokens/nope', body: { name: 'x' } })).status).toBe(404);

    const revoked = await asAdmin({ method: 'POST', path: `/api/tokens/${token.id}/revoke` });
    expect(revoked.json().token.revokedAt).toBeDefined();
    expect(tokenStore.get(token.id)?.revokedAt).toBeDefined();

    const events = auditLog.query({ tokenId: token.id }).map(e => e.event);
    expect(events).toEqual(['token_revoked', 'token_updated', 'token_created']);
  });

  it('revokes with an empty body, still refusing non-JSON content and other origins', async () => {
    const { token } = (await asAdmin({ method: 'POST', path: '/api/tokens', body: { name: 'bare', tools: ['imap_search_emails'] } })).json();
    const revoke = (headers: Record<string, string> = {}) =>
      asAdmin({ method: 'POST', path: `/api/tokens/${token.id}/revoke`, json: false, headers });

    expect((await revoke({ origin: 'http://evil.example' })).status).toBe(403);
    expect((await revoke({ 'content-type': 'text/plain' })).status).toBe(415);
    expect(tokenStore.get(token.id)?.revokedAt).toBeUndefined();

    const revoked = await revoke();
    expect(revoked.status).toBe(200);
    expect(revoked.json().token.revokedAt).toBeDefined();
  });

  it('answers audit queries', async () => {
    const res = await asAdmin({ path: '/api/audit?limit=2' });
    expect(res.status).toBe(200);
    expect(res.json()).toHaveLength(2);
    expect(res.json()[0].ts >= res.json()[1].ts).toBe(true);
  });
});

describe('admin account changes', () => {
  it('drops cached connections after an update or removal, and audits every change', async () => {
    await asAdmin({ method: 'PUT', path: '/api/accounts/acc1', body: { name: 'Renamed' } });
    expect(imapService.disconnect).toHaveBeenCalledWith('acc1');
    expect(smtpService.disconnect).toHaveBeenCalledWith('acc1');

    await asAdmin({ method: 'DELETE', path: '/api/accounts/acc1' });
    expect(imapService.disconnect).toHaveBeenCalledTimes(2);

    await asAdmin({ method: 'POST', path: '/api/accounts', body: { name: 'New', host: 'imap.example.com', imapUsername: 'u@example.com', password: 'pw' } });

    const events = auditLog.query({ limit: 3 }).map(e => [e.event, e.args?.accountId]);
    expect(events).toEqual([['account_created', 'new-acc'], ['account_removed', 'acc1'], ['account_updated', 'acc1']]);
  });
});
