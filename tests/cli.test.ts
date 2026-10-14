import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { promises as fsp, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { runCli } from '../src/cli/index.js';
import { ALIASES } from '../src/cli/commands.js';
import { TOOL_GROUPS, HTTP_FORBIDDEN } from '../src/tools/policy.js';
import { collectToolDefinitions } from '../src/tools/registry.js';
import { httpToolDefinitions } from '../src/http/overrides.js';
import { createMcpRouter } from '../src/http/mcp.js';
import { TokenStore } from '../src/services/token-store.js';
import { AuditLog } from '../src/services/audit-log.js';

const alias = (name: string) => ALIASES.find(entry => entry.command.split(' ')[0] === name)!;

/** Run the CLI in-process and capture what it prints. */
async function cli(argv: string[], env: Record<string, string | undefined> = {}) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, { env, stdout: text => (stdout += text), stderr: text => (stderr += text) });
  return { code, stdout, stderr, json: () => JSON.parse(stdout), error: () => JSON.parse(stderr).error };
}

describe('aliases', () => {
  it('map to the right tool and arguments', () => {
    expect(alias('accounts').tool).toBe('imap_list_accounts');
    expect(alias('folders').args([], { account: 'Work' })).toEqual({ accountName: 'Work' });
    expect(alias('latest').args([], { folder: 'Archive', count: '5', includeBody: true }))
      .toEqual({ folder: 'Archive', count: 5, includeBody: true });
    expect(alias('search').args([], { from: 'boss', body: 'invoice', since: '2026-10-01', unseen: true, limit: '20' }))
      .toEqual({ from: 'boss', body: 'invoice', since: '2026-10-01', seen: false, limit: 20 });
    expect(alias('get').args(['42'], { format: 'text' })).toEqual({ uid: 42, bodyFormat: 'text' });
    expect(alias('mark-read').args([['7']], {})).toEqual({ uid: 7 });
    expect(alias('mark-read').args([['7', '8']], { folder: 'INBOX' })).toEqual({ folder: 'INBOX', uid: [7, 8] });
    expect(alias('attachment').args(['9', 'report.pdf'], { out: 'x' })).toEqual({ uid: 9, filename: 'report.pdf' });
    expect(() => alias('get').args(['abc'], {})).toThrow(/Invalid uid/);

    const expected = { accounts: 'imap_list_accounts', folders: 'imap_list_folders', latest: 'imap_get_latest_emails', search: 'imap_search_emails', get: 'imap_get_email', 'mark-read': 'imap_mark_as_read', attachment: 'imap_download_attachment' };
    expect(Object.fromEntries(ALIASES.map(entry => [entry.command.split(' ')[0], entry.tool]))).toEqual(expected);
  });

  it('only use classified tools that a token can be granted', () => {
    const classified = new Set(Object.values(TOOL_GROUPS).flat());
    for (const { tool } of ALIASES) {
      expect(classified.has(tool), tool).toBe(true);
      expect(HTTP_FORBIDDEN, tool).not.toContain(tool);
    }
  });
});

describe('token handling', () => {
  it('has no option that takes a token, and rejects one as a usage error', async () => {
    const commands = ['', 'tools', 'call', ...ALIASES.map(entry => entry.command.split(' ')[0])];
    for (const command of commands) {
      const help = await cli([...(command ? [command] : []), '--help']);
      expect(help.code, command).toBe(0);
      expect(help.stdout, command).not.toMatch(/--token/);
    }

    const result = await cli(['--token', 'imcp_x', 'tools'], { IMAP_MCP_URL: 'http://127.0.0.1:1/mcp' });
    expect(result.code).toBe(2);
    expect(result.error()).toMatchObject({ type: 'usage' });
  });

  it('asks for IMAP_MCP_TOKEN and IMAP_MCP_URL before connecting', async () => {
    expect((await cli(['tools'], { IMAP_MCP_URL: 'http://127.0.0.1:1/mcp' })).error().message).toMatch(/IMAP_MCP_TOKEN/);
    expect((await cli(['tools'], { IMAP_MCP_TOKEN: 'imcp_x' })).error().message).toMatch(/IMAP_MCP_URL/);
    expect((await cli(['call', 'imap_list_accounts', '[1]'], { IMAP_MCP_URL: 'http://x/mcp', IMAP_MCP_TOKEN: 't' })).code).toBe(2);
  });
});

// End to end against an in-process /mcp endpoint with fake services.
describe('against the MCP endpoint', () => {
  const imapService = {
    getLatestEmails: vi.fn(async () => [{ uid: 1, subject: 'Hello', from: 'a@example.com' }]),
    moveEmail: vi.fn(async () => { throw new Error('No such folder'); }),
    getAttachmentContent: vi.fn(async () => ({ content: Buffer.from([0, 1, 2, 254, 255]), contentType: 'application/octet-stream', filename: 'blob.bin' })),
    findDraftsFolder: vi.fn(async () => 'Drafts'),
  };
  // The endpoint wraps smtpService.sendEmail to see the envelope; keep the spy.
  const sendEmail = vi.fn();
  const services: any = {
    imapService,
    accountManager: { resolveAccountId: (id?: string) => id ?? 'acc1' },
    smtpService: { sendEmail },
    spamService: {},
  };

  let dir: string;
  let server: Server;
  let auditLog: AuditLog;
  let env: Record<string, string>;
  let tokenId: string;

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'imap-mcp-cli-'));
    const tokenStore = new TokenStore(path.join(dir, 'tokens.json'));
    auditLog = new AuditLog(path.join(dir, 'audit.log'));
    const { info, token } = await tokenStore.create('cli', ['imap_get_latest_emails', 'imap_move_email', 'imap_download_attachment', 'imap_save_draft']);
    tokenId = info.id;

    const app = express();
    app.use(createMcpRouter({
      definitions: httpToolDefinitions(collectToolDefinitions(services), services),
      smtpService: services.smtpService,
      tokenStore,
      auditLog,
      allowedOrigins: [],
      maxBodyBytes: 1024 * 1024,
    }));
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    env = { IMAP_MCP_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, IMAP_MCP_TOKEN: token };
  });

  afterAll(async () => {
    server?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('prints the tool JSON and exits 0', async () => {
    const result = await cli(['latest', '--count', '5'], env);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.json()).toEqual({ messages: [{ uid: 1, subject: 'Hello', from: 'a@example.com' }] });
    expect(imapService.getLatestEmails).toHaveBeenCalledWith('acc1', 'INBOX', 5, expect.anything());

    const pretty = await cli(['--pretty', 'latest'], env);
    expect(pretty.stdout).toContain('\n  "messages"');
  });

  it('exits 1 when the tool answers success:false, still printing its JSON', async () => {
    const result = await cli(['call', 'imap_move_email', '{"uid":3,"targetFolder":"Nowhere"}'], env);
    expect(result.code).toBe(1);
    expect(result.json()).toMatchObject({ success: false, error: expect.stringContaining('No such folder') });
  });

  it('exits 3 with a JSON error for a tool the token may not use, which is audited as denied', async () => {
    const result = await cli(['call', 'imap_send_email', '{"to":"x@example.com","subject":"s","text":"t"}'], env);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.error()).toEqual({ type: 'denied', message: 'Tool imap_send_email is not available to this token.' });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(auditLog.query({ tokenId, tool: 'imap_send_email' })[0]).toMatchObject({ outcome: 'denied' });
  });

  it('exits 3 when the server refuses an allowed tool by policy, but 1 for an ordinary tool error', async () => {
    const refused = await cli(['call', 'imap_save_draft', '{"folder":"INBOX","to":"a@example.com","subject":"s","text":"t"}'], env);
    expect(refused.code).toBe(3);
    expect(refused.stdout).toBe('');
    expect(refused.error()).toMatchObject({ type: 'denied', message: expect.stringContaining('Drafts folder') });

    imapService.getLatestEmails.mockRejectedValueOnce(new Error('IMAP connection lost'));
    const failed = await cli(['latest'], env);
    expect(failed.code).toBe(1);
    expect(failed.error()).toMatchObject({ type: 'tool', message: expect.stringContaining('IMAP connection lost') });
  });

  it('exits 3 for an invalid token', async () => {
    const result = await cli(['tools'], { ...env, IMAP_MCP_TOKEN: 'imcp_aaaaaaaaaa_' + 'b'.repeat(43) });
    expect(result.code).toBe(3);
    expect(result.error().type).toBe('auth');
  });

  it('exits 4 when the server cannot be reached', async () => {
    const closed = express().listen(0, '127.0.0.1');
    await new Promise(resolve => closed.once('listening', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise(resolve => closed.close(resolve));

    const result = await cli(['tools'], { ...env, IMAP_MCP_URL: `http://127.0.0.1:${port}/mcp` });
    expect(result.code).toBe(4);
    expect(result.error().type).toBe('network');
  });

  it('writes attachment bytes to --out and prints where', async () => {
    const out = path.join(dir, 'saved.bin');
    const result = await cli(['attachment', '12', 'blob.bin', '--out', out], env);
    expect(result.code).toBe(0);
    expect(readFileSync(out)).toEqual(Buffer.from([0, 1, 2, 254, 255]));
    expect(result.json()).toMatchObject({ savedTo: out, size: 5, filename: 'blob.bin', contentType: 'application/octet-stream' });

    expect((await cli(['attachment', '12', 'blob.bin'], env)).code).toBe(2);
  });

  it('lists the token\'s tools with their schemas', async () => {
    const result = await cli(['tools'], env);
    expect(result.code).toBe(0);
    const tools = result.json();
    expect(tools.map((tool: any) => tool.name)).toEqual(['imap_download_attachment', 'imap_move_email', 'imap_get_latest_emails', 'imap_save_draft']);
    expect(tools[0].inputSchema).toBeDefined();
  });
});
