import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs';
import path from 'path';
import os from 'os';

export type AuditEvent =
  | 'tool_call'
  | 'auth_failed'
  | 'token_created'
  | 'token_updated'
  | 'token_revoked'
  | 'account_created'
  | 'account_updated'
  | 'account_removed';

export interface AuditEntry {
  ts: string;
  event: AuditEvent;
  tokenId?: string;
  tokenName?: string;
  tool?: string;
  outcome?: 'ok' | 'error' | 'denied';
  durationMs?: number;
  ip?: string;
  args?: Record<string, unknown>;
}

export interface AuditQuery {
  limit?: number;
  /** Only entries strictly older than this ISO timestamp (paging cursor). */
  before?: string;
  tokenId?: string;
  tool?: string;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_QUERY_LIMIT = 1000;

/**
 * Append-only JSONL audit trail at ~/.imap-mcp/audit.log (0600). When the file
 * would grow past `maxBytes` it is rotated to audit.log.1, replacing the
 * previous one. Entries carry identifiers only — see summarizeArgs().
 */
export class AuditLog {
  private filePath: string;
  private maxBytes: number;

  constructor(filePath: string = path.join(os.homedir(), '.imap-mcp', 'audit.log'), maxBytes = DEFAULT_MAX_BYTES) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
  }

  record(entry: Omit<AuditEntry, 'ts'>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      if (this.size() + Buffer.byteLength(line) > this.maxBytes) {
        renameSync(this.filePath, `${this.filePath}.1`);
      }
      appendFileSync(this.filePath, line, { mode: 0o600 });
    } catch (error) {
      // Never fail the audited operation because the log could not be written.
      console.error('[imap-mcp] Failed to write audit log:', error instanceof Error ? error.message : error);
    }
  }

  /** Matching entries, newest first, from the current and the rotated file. */
  query({ limit = 100, before, tokenId, tool }: AuditQuery = {}): AuditEntry[] {
    const max = Math.min(Math.max(1, Math.floor(limit) || 1), MAX_QUERY_LIMIT);
    const results: AuditEntry[] = [];
    for (const file of [this.filePath, `${this.filePath}.1`]) {
      const lines = this.readLines(file);
      for (let i = lines.length - 1; i >= 0 && results.length < max; i--) {
        let entry: AuditEntry;
        try {
          entry = JSON.parse(lines[i]);
        } catch {
          continue; // a torn last line after a crash
        }
        if (before && !(entry.ts < before)) continue;
        if (tokenId && entry.tokenId !== tokenId) continue;
        if (tool && entry.tool !== tool) continue;
        results.push(entry);
      }
    }
    return results;
  }

  private size(): number {
    try {
      return statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  private readLines(file: string): string[] {
    try {
      return readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}

const SEND_TOOLS = new Set(['imap_send_email', 'imap_reply_to_email', 'imap_forward_email']);
const SEARCH_TOOLS = new Set(['imap_search_emails', 'imap_bulk_delete_by_search', 'imap_check_spam']);
const LOCATION_FIELDS = ['accountId', 'accountName', 'folder', 'sourceFolder', 'searchFolder', 'targetFolder'];
const OPTION_FIELDS = ['limit', 'count', 'dryRun', 'searchAllFolders', 'includeBody', 'replyAll'];
const CRITERIA_FIELDS = ['from', 'to', 'subject', 'body', 'since', 'before', 'seen', 'flagged', 'messageId', 'keywords', 'unKeywords'];

export interface Recipients {
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
}

/**
 * Whitelisted summary of a tool call's arguments for the audit log: account,
 * folders, uids (only a count for batches) and a few options. Search criteria
 * are reduced to their names. Send/reply/forward record the full recipients —
 * `recipients` when the actual SMTP envelope is known, else the requested
 * to/cc/bcc. Message text, subjects, credentials and attachment content never
 * appear (AGENTS.md security rule 1).
 */
export function summarizeArgs(
  tool: string,
  args: Record<string, unknown> = {},
  recipients?: Recipients
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const field of [...LOCATION_FIELDS, ...OPTION_FIELDS]) {
    if (args[field] !== undefined) summary[field] = args[field];
  }
  for (const field of ['uid', 'uids']) {
    const value = args[field];
    if (Array.isArray(value)) summary[`${field}Count`] = value.length;
    else if (value !== undefined) summary[field] = value;
  }
  if (SEARCH_TOOLS.has(tool)) {
    const criteria = CRITERIA_FIELDS.filter(field => args[field] !== undefined);
    if (criteria.length > 0) summary.criteria = criteria;
  }
  if (SEND_TOOLS.has(tool)) {
    const source: Recipients = recipients ?? (args as Recipients);
    const picked = Object.fromEntries(
      (['to', 'cc', 'bcc'] as const).filter(field => source[field] !== undefined).map(field => [field, source[field]])
    );
    if (Object.keys(picked).length > 0) summary.recipients = picked;
  }
  return summary;
}
