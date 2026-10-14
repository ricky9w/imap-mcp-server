import { promises as fs, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

/** An agent token as stored. Only the SHA-256 of the secret is kept. */
export interface AgentToken {
  id: string;
  name: string;
  hash: string;
  tools: string[];
  createdAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
  lastUsedFrom?: string;
}

/** A token as callers see it: everything except the hash. */
export type AgentTokenInfo = Omit<AgentToken, 'hash'>;

// imcp_<id>_<secret>: a public 10-character base32 id (shown in the UI and the
// audit log) and a 32-byte base64url secret.
const TOKEN_PATTERN = /^imcp_([a-z2-7]{10})_([A-Za-z0-9_-]{43})$/;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const LAST_USED_FLUSH_MS = 60 * 1000;

const hashSecret = (secret: string): string => crypto.createHash('sha256').update(secret).digest('hex');

const withoutHash = ({ hash: _hash, ...info }: AgentToken): AgentTokenInfo => ({ ...info });

/**
 * Agent tokens for the HTTP endpoint, stored in ~/.imap-mcp/tokens.json.
 * Only the serve process writes the file, so it is read once at startup.
 * Revoking keeps the record (for the audit trail); last-used is kept in
 * memory and written at most once a minute, or on flush().
 */
export class TokenStore {
  private filePath: string;
  private tokens: Map<string, AgentToken> = new Map();
  private flushTimer?: NodeJS.Timeout;
  private writing: Promise<void> = Promise.resolve();

  constructor(filePath: string = path.join(os.homedir(), '.imap-mcp', 'tokens.json')) {
    this.filePath = filePath;
    this.load();
  }

  list(): AgentTokenInfo[] {
    return Array.from(this.tokens.values()).map(withoutHash);
  }

  get(id: string): AgentTokenInfo | undefined {
    const token = this.tokens.get(id);
    return token ? withoutHash(token) : undefined;
  }

  /** Create a token. The returned `token` string is the only copy of the secret. */
  async create(name: string, tools: string[]): Promise<{ info: AgentTokenInfo; token: string }> {
    let id: string;
    do {
      id = Array.from(crypto.randomBytes(10), byte => ID_ALPHABET[byte & 31]).join('');
    } while (this.tokens.has(id));
    const secret = crypto.randomBytes(32).toString('base64url');

    const record: AgentToken = {
      id,
      name,
      hash: hashSecret(secret),
      tools: [...tools],
      createdAt: new Date().toISOString(),
    };
    this.tokens.set(id, record);
    await this.save();
    return { info: withoutHash(record), token: `imcp_${id}_${secret}` };
  }

  async update(id: string, updates: { name?: string; tools?: string[] }): Promise<AgentTokenInfo> {
    const record = this.tokens.get(id);
    if (!record) {
      throw new Error(`Token ${id} not found`);
    }
    if (updates.name !== undefined) record.name = updates.name;
    if (updates.tools !== undefined) record.tools = [...updates.tools];
    await this.save();
    return withoutHash(record);
  }

  async revoke(id: string): Promise<AgentTokenInfo> {
    const record = this.tokens.get(id);
    if (!record) {
      throw new Error(`Token ${id} not found`);
    }
    record.revokedAt ??= new Date().toISOString();
    await this.save();
    return withoutHash(record);
  }

  /** The token a presented `imcp_…` string belongs to, unless it is malformed, wrong or revoked. */
  verify(presented: string): AgentTokenInfo | undefined {
    const match = TOKEN_PATTERN.exec(presented);
    const record = match ? this.tokens.get(match[1]) : undefined;
    if (!match || !record) {
      return undefined;
    }
    const expected = Buffer.from(record.hash, 'hex');
    const given = Buffer.from(hashSecret(match[2]), 'hex');
    if (!crypto.timingSafeEqual(given, expected) || record.revokedAt) {
      return undefined;
    }
    return withoutHash(record);
  }

  /** The public id of a well-formed token string (for the audit log), whether or not it is valid. */
  static idOf(presented: string): string | undefined {
    return TOKEN_PATTERN.exec(presented)?.[1];
  }

  /** Note a successful use; written to disk at most once a minute. */
  recordUse(id: string, from?: string): void {
    const record = this.tokens.get(id);
    if (!record) return;
    record.lastUsedAt = new Date().toISOString();
    record.lastUsedFrom = from;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.save().catch(error => {
          console.error('[imap-mcp] Failed to save token last-used times:', error instanceof Error ? error.message : error);
        });
      }, LAST_USED_FLUSH_MS);
      this.flushTimer.unref();
    }
  }

  /** Write pending last-used times now (on shutdown). */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.save();
  }

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf-8')) as { tokens?: AgentToken[] };
      for (const token of data.tokens ?? []) {
        this.tokens.set(token.id, token);
      }
    } catch (error) {
      // No tokens yet is fine; anything else means the file is unreadable.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot read ${this.filePath}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  // Writes are chained so a slower, older snapshot can never land last.
  private save(): Promise<void> {
    const write = this.writing.then(() => this.write());
    this.writing = write.catch(() => {});
    return write;
  }

  // Temporary file + rename, owner-only — same as AccountManager.saveAccounts.
  private async write(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const data = JSON.stringify({ version: 1, tokens: Array.from(this.tokens.values()) }, null, 2);
    const tmpPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmpPath, data, { mode: 0o600 });
      await fs.rename(tmpPath, this.filePath);
    } catch (error) {
      try {
        await fs.rm(tmpPath, { force: true });
      } catch {
        // best effort — the original error is what matters
      }
      throw error;
    }
  }
}
