import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { promises as fsp, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { collectToolDefinitions } from '../src/tools/registry.js';
import { httpToolDefinitions } from '../src/http/overrides.js';
import { DENIED_META_KEY } from '../src/utils/denied.js';
import { TokenStore } from '../src/services/token-store.js';
import { AuditLog } from '../src/services/audit-log.js';
import { createMcpRouter } from '../src/http/mcp.js';
import { hostGuard } from '../src/http/guards.js';

// The /mcp endpoint end to end: real SDK client, real tool handlers over fake
// services, real token and audit files in a temp dir.
const imapService = {
  searchEmails: vi.fn(async () => []),
  findDraftsFolder: vi.fn(async () => 'Drafts'),
};
// The endpoint wraps smtpService.sendEmail to see the envelope; keep the spy.
const sendEmail = vi.fn(async () => ({ messageId: '<sent-1@example.com>' }));
const smtpService = { sendEmail };
const accountManager = {
  resolveAccountId: (id?: string) => id ?? 'acc1',
  getAccount: async () => ({
    id: 'acc1',
    name: 'Work',
    email: 'me@example.com',
    user: 'me@example.com',
    defaultBcc: 'archive@example.com',
    saveToSent: false,
  }),
};

let dir: string;
let tokenStore: TokenStore;
let auditLog: AuditLog;
let httpServer: Server;
let port: number;

const listen = (app: express.Express) =>
  new Promise<Server>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });

const services: any = { imapService, accountManager, smtpService, spamService: {} };

const mcpApp = (opts: { allowedHosts?: string[]; allowedOrigins?: string[]; maxBodyBytes?: number } = {}) => {
  const app = express();
  app.use(hostGuard('127.0.0.1', opts.allowedHosts ?? []));
  app.use(createMcpRouter({
    definitions: httpToolDefinitions(collectToolDefinitions(services), services),
    smtpService: smtpService as any,
    tokenStore,
    auditLog,
    allowedOrigins: opts.allowedOrigins ?? [],
    maxBodyBytes: opts.maxBodyBytes ?? 1024 * 1024,
  }));
  return app;
};

const connect = async (token: string, targetPort = port) => {
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${targetPort}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
};

const toolNames = async (client: Client) => (await client.listTools()).tools.map(tool => tool.name);

const auditEntries = () => auditLog.query({ limit: 1000 }).reverse();

function rawRequest(opts: { method?: string; headers?: Record<string, string>; body?: string; targetPort?: number }) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: opts.targetPort ?? port, method: opts.method ?? 'POST', path: '/mcp', headers: opts.headers },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
});
const jsonHeaders = (token?: string): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'imap-mcp-http-'));
  tokenStore = new TokenStore(path.join(dir, 'tokens.json'));
  auditLog = new AuditLog(path.join(dir, 'audit.log'));
  httpServer = await listen(mcpApp());
  port = (httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  httpServer?.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /mcp authentication', () => {
  it('rejects a missing or unknown token with 401', async () => {
    expect((await rawRequest({ headers: jsonHeaders(), body: initializeBody })).status).toBe(401);
    expect((await rawRequest({ headers: jsonHeaders('imcp_aaaaaaaaaa_' + 'x'.repeat(43)), body: initializeBody })).status).toBe(401);
    const error = await connect('not-a-token').catch(e => e);
    expect(error).toBeInstanceOf(StreamableHTTPError);
    expect(error.code).toBe(401);
    expect(auditEntries().filter(e => e.event === 'auth_failed').length).toBeGreaterThanOrEqual(3);
  });

  it('rejects a revoked token on the very next request', async () => {
    const { info, token } = await tokenStore.create('soon revoked', ['imap_search_emails']);
    const client = await connect(token);
    expect(await toolNames(client)).toEqual(['imap_search_emails']);

    await tokenStore.revoke(info.id);
    const error = await client.listTools().catch(e => e);
    expect(error).toBeInstanceOf(StreamableHTTPError);
    expect(error.code).toBe(401);
  });
});

describe('POST /mcp tool access', () => {
  it('lists exactly the effective tools, never the admin group', async () => {
    const { token } = await tokenStore.create('reader', [
      'imap_search_emails', 'imap_mark_as_read', 'imap_update_account', 'imap_add_account', 'imap_disconnect',
    ]);
    const client = await connect(token);
    expect(await toolNames(client)).toEqual(['imap_search_emails', 'imap_mark_as_read']);
    await client.close();
  });

  it('refuses tools the token lacks without touching the services, and audits it', async () => {
    const { info, token } = await tokenStore.create('reader-2', ['imap_search_emails']);
    const client = await connect(token);

    const result: any = await client.callTool({ name: 'imap_send_email', arguments: { to: 'x@evil.example', subject: 's', text: 't' } });
    expect(result.isError).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();

    const updateResult: any = await client.callTool({ name: 'imap_update_account', arguments: { accountId: 'acc1', host: 'evil.example' } });
    expect(updateResult.isError).toBe(true);

    const denied = auditEntries().filter(e => e.tokenId === info.id && e.outcome === 'denied').map(e => e.tool);
    expect(denied).toEqual(['imap_send_email', 'imap_update_account']);
    await client.close();
  });

  it('runs allowed calls and audits them with a summary', async () => {
    const { info, token } = await tokenStore.create('searcher', ['imap_search_emails']);
    const client = await connect(token);

    const result: any = await client.callTool({ name: 'imap_search_emails', arguments: { folder: 'INBOX', from: 'boss@example.com' } });
    expect(result.isError).toBeFalsy();
    expect(imapService.searchEmails).toHaveBeenCalledOnce();

    const entry = auditEntries().find(e => e.tokenId === info.id && e.tool === 'imap_search_emails');
    expect(entry).toMatchObject({ event: 'tool_call', outcome: 'ok', tokenName: 'searcher', args: { folder: 'INBOX', criteria: ['from'] } });
    expect(entry?.ip).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain('boss@example.com');
    await client.close();
  });

  it('audits the recipients actually sent to, never the subject or body', async () => {
    const { info, token } = await tokenStore.create('sender', ['imap_send_email']);
    const client = await connect(token);

    await client.callTool({
      name: 'imap_send_email',
      arguments: { to: 'alice@example.com', cc: ['bob@example.com'], bcc: 'carol@example.com', subject: 'Top secret subject', text: 'Top secret body' },
    });
    expect(sendEmail).toHaveBeenCalledOnce();

    const entry = auditEntries().find(e => e.tokenId === info.id && e.tool === 'imap_send_email');
    expect(entry).toMatchObject({ outcome: 'ok' });
    expect((entry?.args as any).recipients).toEqual({
      to: 'alice@example.com',
      cc: ['bob@example.com'],
      // defaultBcc merged in by the tool is part of the real envelope.
      bcc: ['carol@example.com', 'archive@example.com'],
    });
    const raw = readFileSync(path.join(dir, 'audit.log'), 'utf-8');
    expect(raw).not.toContain('Top secret');
    expect(raw).not.toContain(token);
    await client.close();
  });

  it('marks a refusal by policy, unlike an ordinary tool error, and audits it as denied', async () => {
    const { info, token } = await tokenStore.create('drafter', ['imap_save_draft', 'imap_search_emails']);
    const client = await connect(token);

    const refused: any = await client.callTool({ name: 'imap_save_draft', arguments: { folder: 'INBOX', to: 'a@example.com', subject: 's', text: 't' } });
    expect(refused.isError).toBe(true);
    expect(refused._meta?.[DENIED_META_KEY]).toBe(true);
    expect(refused.content[0].text).toMatch(/Drafts folder/);
    expect(auditEntries().find(e => e.tokenId === info.id && e.tool === 'imap_save_draft')).toMatchObject({ outcome: 'denied' });

    imapService.searchEmails.mockRejectedValueOnce(new Error('IMAP connection lost'));
    const failed: any = await client.callTool({ name: 'imap_search_emails', arguments: { folder: 'INBOX' } });
    expect(failed.isError).toBe(true);
    expect(failed._meta?.[DENIED_META_KEY]).toBeUndefined();
    await client.close();
  });

  it('narrows tokens by IMAP_MCP_READ_ONLY when it is set', async () => {
    const { token } = await tokenStore.create('ceilinged', ['imap_search_emails', 'imap_send_email']);
    vi.stubEnv('IMAP_MCP_READ_ONLY', 'true');
    const client = await connect(token);
    expect(await toolNames(client)).toEqual(['imap_search_emails']);
    await client.close();
  });

  it('keeps concurrent clients with different tokens apart', async () => {
    const reader = await connect((await tokenStore.create('par-reader', ['imap_search_emails'])).token);
    const sender = await connect((await tokenStore.create('par-sender', ['imap_send_email'])).token);

    const lists = await Promise.all(Array.from({ length: 10 }, (_, i) => toolNames(i % 2 ? sender : reader)));
    lists.forEach((names, i) => expect(names).toEqual(i % 2 ? ['imap_send_email'] : ['imap_search_emails']));
    await reader.close();
    await sender.close();
  });
});

describe('POST /mcp request guards', () => {
  let token: string;
  beforeAll(async () => {
    token = (await tokenStore.create('guards', ['imap_search_emails'])).token;
  });

  it('refuses browser origins unless listed', async () => {
    const res = await rawRequest({ headers: { ...jsonHeaders(token), origin: 'http://evil.example' }, body: initializeBody });
    expect(res.status).toBe(403);

    const app = await listen(mcpApp({ allowedOrigins: ['https://console.example.com'] }));
    const listedPort = (app.address() as AddressInfo).port;
    const listed = await rawRequest({ targetPort: listedPort, headers: { ...jsonHeaders(token), origin: 'https://console.example.com' }, body: initializeBody });
    expect(listed.status).toBe(200);
    app.close();
  });

  it('answers only loopback Host names when bound to loopback, or the configured hosts', async () => {
    expect((await rawRequest({ headers: { ...jsonHeaders(token), host: 'evil.example' }, body: initializeBody })).status).toBe(403);

    const app = await listen(mcpApp({ allowedHosts: ['mail.example.com'] }));
    const hostPort = (app.address() as AddressInfo).port;
    expect((await rawRequest({ targetPort: hostPort, headers: { ...jsonHeaders(token), host: `127.0.0.1:${hostPort}` }, body: initializeBody })).status).toBe(403);
    expect((await rawRequest({ targetPort: hostPort, headers: { ...jsonHeaders(token), host: 'mail.example.com' }, body: initializeBody })).status).toBe(200);
    app.close();
  });

  it('answers GET and DELETE with 405', async () => {
    expect((await rawRequest({ method: 'GET', headers: jsonHeaders(token) })).status).toBe(405);
    expect((await rawRequest({ method: 'DELETE', headers: jsonHeaders(token) })).status).toBe(405);
  });

  it('rejects an oversized body with 413 after authentication', async () => {
    const app = await listen(mcpApp({ maxBodyBytes: 1000 }));
    const smallPort = (app.address() as AddressInfo).port;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(2000) } });
    expect((await rawRequest({ targetPort: smallPort, headers: jsonHeaders(token), body })).status).toBe(413);
    // Unauthenticated requests are refused before the body is read at all.
    expect((await rawRequest({ targetPort: smallPort, headers: jsonHeaders(), body })).status).toBe(401);
    app.close();
  });
});
