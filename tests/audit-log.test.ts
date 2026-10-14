import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp, readFileSync, statSync } from 'fs';
import path from 'path';
import os from 'os';
import { AuditLog, summarizeArgs } from '../src/services/audit-log.js';

describe('summarizeArgs', () => {
  const secretArgs = {
    accountId: 'acc1',
    folder: 'INBOX',
    subject: 'Quarterly numbers',
    text: 'plain body',
    html: '<p>html body</p>',
    body: 'search body text',
    password: 'hunter2',
    content: 'YmFzZTY0',
    attachments: [{ filename: 'a.pdf', content: 'YmFzZTY0' }],
  };

  it('never carries message text, subjects, credentials or attachment content', () => {
    for (const tool of ['imap_send_email', 'imap_save_draft', 'imap_search_emails', 'imap_upload_file', 'imap_add_account']) {
      const summary = summarizeArgs(tool, secretArgs);
      const raw = JSON.stringify(summary);
      for (const key of ['text', 'html', 'body', 'subject', 'password', 'content', 'attachments']) {
        expect(summary, `${tool}: ${key}`).not.toHaveProperty(key);
      }
      for (const value of ['Quarterly numbers', 'plain body', 'html body', 'search body text', 'hunter2', 'YmFzZTY0']) {
        expect(raw, `${tool}: ${value}`).not.toContain(value);
      }
      expect(summary).toMatchObject({ accountId: 'acc1', folder: 'INBOX' });
    }
  });

  it('reduces search criteria to their names', () => {
    expect(summarizeArgs('imap_search_emails', { folder: 'INBOX', from: 'boss@example.com', body: 'salary', limit: 5 }))
      .toEqual({ folder: 'INBOX', limit: 5, criteria: ['from', 'body'] });
  });

  it('counts batched uids instead of listing them', () => {
    expect(summarizeArgs('imap_mark_as_read', { folder: 'INBOX', uid: [1, 2, 3] })).toEqual({ folder: 'INBOX', uidCount: 3 });
    expect(summarizeArgs('imap_get_email', { folder: 'INBOX', uid: 7 })).toEqual({ folder: 'INBOX', uid: 7 });
    expect(summarizeArgs('imap_bulk_delete', { uids: [4, 5], dryRun: false })).toEqual({ dryRun: false, uidsCount: 2 });
  });

  it('records the full recipients of outbound mail, preferring the actual envelope', () => {
    expect(summarizeArgs('imap_send_email', { to: ['a@x.com', 'b@y.com'], cc: 'c@z.com', subject: 'hi' }))
      .toEqual({ recipients: { to: ['a@x.com', 'b@y.com'], cc: 'c@z.com' } });
    // A reply's recipients are derived server-side; the envelope is what was sent.
    expect(summarizeArgs('imap_reply_to_email', { folder: 'INBOX', uid: 9, replyAll: true }, { to: ['sender@x.com'], bcc: ['archive@me.com'] }))
      .toEqual({ folder: 'INBOX', uid: 9, replyAll: true, recipients: { to: ['sender@x.com'], bcc: ['archive@me.com'] } });
    // Drafts are not sent: no recipients are recorded.
    expect(summarizeArgs('imap_save_draft', { to: 'a@x.com' })).toEqual({});
  });
});

describe('AuditLog', () => {
  let dir: string;
  const file = () => path.join(dir, 'audit.log');

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'imap-mcp-audit-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('appends one JSON line per event, owner-only', () => {
    const log = new AuditLog(file());
    log.record({ event: 'tool_call', tool: 'imap_search_emails', outcome: 'ok', tokenId: 't1' });
    log.record({ event: 'auth_failed', outcome: 'denied', ip: '10.0.0.1' });

    const lines = readFileSync(file(), 'utf-8').trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ event: 'tool_call', tool: 'imap_search_emails', outcome: 'ok', tokenId: 't1' });
    expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    if (process.platform !== 'win32') {
      expect(statSync(file()).mode & 0o777).toBe(0o600);
    }
  });

  it('rotates to audit.log.1 by size and still queries both files', () => {
    const log = new AuditLog(file(), 400);
    for (let i = 0; i < 10; i++) {
      log.record({ event: 'tool_call', tool: `imap_tool_${i}`, outcome: 'ok' });
    }
    expect(statSync(file()).size).toBeLessThanOrEqual(400);
    expect(statSync(`${file()}.1`).size).toBeGreaterThan(0);

    const tools = log.query({ limit: 1000 }).map(entry => entry.tool);
    // Newest first; whatever survived rotation stays in order.
    expect(tools[0]).toBe('imap_tool_9');
    expect(tools).toEqual([...tools].sort().reverse());
  });

  it('filters by token and tool, pages with before, and caps the limit', () => {
    const log = new AuditLog(file());
    log.record({ event: 'tool_call', tool: 'imap_get_email', tokenId: 'a' });
    log.record({ event: 'tool_call', tool: 'imap_send_email', tokenId: 'b' });
    log.record({ event: 'tool_call', tool: 'imap_get_email', tokenId: 'b' });

    expect(log.query({ tokenId: 'b' }).map(e => e.tool)).toEqual(['imap_get_email', 'imap_send_email']);
    expect(log.query({ tool: 'imap_get_email' }).map(e => e.tokenId)).toEqual(['b', 'a']);
    expect(log.query({ limit: 1 })).toHaveLength(1);
    expect(log.query({ before: '0000' })).toEqual([]);
    expect(log.query({ before: '9999' })).toHaveLength(3);
  });

  it('returns nothing before the first event', () => {
    expect(new AuditLog(file()).query()).toEqual([]);
  });
});
