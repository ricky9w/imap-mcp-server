import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServeApp, parseServeOptions, trustProxySetting } from '../src/http/serve.js';
import { TokenStore } from '../src/services/token-store.js';
import { AuditLog } from '../src/services/audit-log.js';

describe('parseServeOptions', () => {
  it('defaults to 127.0.0.1:8765', () => {
    expect(parseServeOptions([], {})).toEqual({ host: '127.0.0.1', port: 8765 });
  });

  it('takes IMAP_MCP_HTTP_HOST / IMAP_MCP_HTTP_PORT, and flags over them', () => {
    const env = { IMAP_MCP_HTTP_HOST: '0.0.0.0', IMAP_MCP_HTTP_PORT: '9000' };
    expect(parseServeOptions([], env)).toEqual({ host: '0.0.0.0', port: 9000 });
    expect(parseServeOptions(['--host', '::1', '--port', '9100'], env)).toEqual({ host: '::1', port: 9100 });
  });

  it('rejects an invalid port', () => {
    expect(() => parseServeOptions(['--port', 'http'], {})).toThrow(/Invalid port/);
    expect(() => parseServeOptions(['--port', '70000'], {})).toThrow(/Invalid port/);
  });
});

describe('trustProxySetting', () => {
  it('passes IMAP_MCP_TRUST_PROXY through in the shape Express expects', () => {
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting('false')).toBe(false);
    expect(trustProxySetting('true')).toBe(true);
    expect(trustProxySetting('1')).toBe(1);
    expect(trustProxySetting('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });
});

// The whole serve app over HTTP: admin API and /mcp on one port.
describe('serve app', () => {
  const ADMIN = 'serve-admin-token-0123456789';
  let tmpHome: string;
  let prevHome: string | undefined;
  let server: Server;
  let port: number;
  let auditLog: AuditLog;

  // The endpoint wraps smtpService.sendEmail to see the envelope; keep the spy.
  const sendEmail = vi.fn();
  const services: any = {
    imapService: { searchEmails: vi.fn(async () => []), disconnect: vi.fn() },
    accountManager: { resolveAccountId: (id?: string) => id ?? 'acc1', getAllAccounts: () => [] },
    smtpService: { sendEmail, disconnect: vi.fn() },
    spamService: {},
  };

  function request(opts: { method?: string; path: string; headers?: Record<string, string>; body?: unknown }) {
    const data = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (data !== undefined || opts.method === 'POST') headers['content-type'] = 'application/json';
    if (data !== undefined) headers['content-length'] = String(Buffer.byteLength(data));
    return new Promise<{ status: number; json: () => any }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(text) }));
      });
      req.on('error', reject);
      if (data !== undefined) req.write(data);
      req.end();
    });
  }

  const admin = (opts: Parameters<typeof request>[0]) =>
    request({ ...opts, headers: { authorization: `Bearer ${ADMIN}`, ...(opts.headers ?? {}) } });

  const connect = async (token: string, headers: Record<string, string> = {}) => {
    const client = new Client({ name: 'agent', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } },
    }));
    return client;
  };

  beforeAll(async () => {
    prevHome = process.env.HOME;
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'imap-mcp-serve-'));
    process.env.HOME = tmpHome;
    vi.stubEnv('IMAP_MCP_WIZARD_TOKEN', ADMIN);
    vi.stubEnv('IMAP_MCP_TRUST_PROXY', 'loopback');
    auditLog = new AuditLog(path.join(tmpHome, 'audit.log'));
    const app = createServeApp(services, {
      host: '127.0.0.1',
      port: 0,
      tokenStore: new TokenStore(path.join(tmpHome, 'tokens.json')),
      auditLog,
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server?.close();
    vi.unstubAllEnvs();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fsp.rm(tmpHome, { recursive: true, force: true });
  });

  afterEach(() => vi.clearAllMocks());

  it('issues a read_markread token through the admin API that sees exactly its 16 tools', async () => {
    const created = await admin({ method: 'POST', path: '/api/tokens', body: { name: 'laptop', preset: 'read_markread' } });
    expect(created.status).toBe(201);
    const { secret, token } = created.json();

    const client = await connect(secret);
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(16);
    expect(tools.map(t => t.name)).toContain('imap_mark_as_read');
    expect(tools.find(t => t.name === 'imap_download_attachment')?.description).toContain('Nothing is written to the server');

    const sent: any = await client.callTool({ name: 'imap_send_email', arguments: { to: 'x@example.com', subject: 's', text: 't' } });
    expect(sent.isError).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();

    await admin({ method: 'POST', path: `/api/tokens/${token.id}/revoke` });
    const error = await client.listTools().catch(e => e);
    expect(error).toBeInstanceOf(StreamableHTTPError);
    expect(error.code).toBe(401);
  });

  it('keeps agent and admin tokens apart', async () => {
    const { secret } = (await admin({ method: 'POST', path: '/api/tokens', body: { name: 'agent', tools: ['imap_search_emails'] } })).json();

    expect((await request({ path: '/api/tokens', headers: { authorization: `Bearer ${secret}` } })).status).toBe(401);
    const error = await connect(ADMIN).catch(e => e);
    expect(error).toBeInstanceOf(StreamableHTTPError);
    expect(error.code).toBe(401);
  });

  it('records the client address from a trusted proxy', async () => {
    const { secret, token } = (await admin({ method: 'POST', path: '/api/tokens', body: { name: 'proxied', tools: ['imap_search_emails'] } })).json();
    const client = await connect(secret, { 'X-Forwarded-For': '203.0.113.7' });
    await client.callTool({ name: 'imap_search_emails', arguments: { folder: 'INBOX' } });
    await client.close();

    expect(auditLog.query({ tokenId: token.id, tool: 'imap_search_emails' })[0]?.ip).toBe('203.0.113.7');
  });

  it('applies the Host guard to /mcp and the admin UI alike', async () => {
    expect((await admin({ path: '/api/tokens', headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await request({ method: 'POST', path: '/mcp', headers: { host: 'evil.example' }, body: {} })).status).toBe(403);
  });
});
