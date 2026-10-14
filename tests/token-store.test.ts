import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp, readFileSync, statSync } from 'fs';
import path from 'path';
import os from 'os';
import { TokenStore } from '../src/services/token-store.js';

// Real filesystem in a throwaway HOME (os.homedir() honours $HOME).
describe('TokenStore', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  const file = () => path.join(tmpHome, '.imap-mcp', 'tokens.json');
  const stored = () => JSON.parse(readFileSync(file(), 'utf-8')).tokens;

  beforeEach(async () => {
    prevHome = process.env.HOME;
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'imap-mcp-tokens-'));
    process.env.HOME = tmpHome;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fsp.rm(tmpHome, { recursive: true, force: true });
  });

  it('hands out the secret once and stores only its hash, owner-only', async () => {
    const store = new TokenStore();
    const { info, token } = await store.create('laptop', ['imap_search_emails']);

    expect(token).toMatch(/^imcp_[a-z2-7]{10}_[A-Za-z0-9_-]{43}$/);
    expect(token.startsWith(`imcp_${info.id}_`)).toBe(true);
    const secret = token.slice(`imcp_${info.id}_`.length);

    const raw = readFileSync(file(), 'utf-8');
    expect(raw).not.toContain(secret);
    expect(stored()[0]).toMatchObject({ id: info.id, name: 'laptop', tools: ['imap_search_emails'] });
    expect(stored()[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.list()[0]).not.toHaveProperty('hash');
    if (process.platform !== 'win32') {
      expect(statSync(file()).mode & 0o777).toBe(0o600);
    }
  });

  it('verifies the right token and rejects wrong, malformed and revoked ones', async () => {
    const store = new TokenStore();
    const { info, token } = await store.create('laptop', ['imap_search_emails']);
    const other = await store.create('desktop', []);

    expect(store.verify(token)?.id).toBe(info.id);
    // Right id, someone else's secret.
    const otherSecret = other.token.slice(`imcp_${other.info.id}_`.length);
    expect(store.verify(`imcp_${info.id}_${otherSecret}`)).toBeUndefined();
    expect(store.verify('imcp_aaaaaaaaaa_short')).toBeUndefined();
    expect(store.verify('not-a-token')).toBeUndefined();

    await store.revoke(info.id);
    expect(store.verify(token)).toBeUndefined();
    expect(store.verify(other.token)?.id).toBe(other.info.id);

    // Revocation is persisted and the record is kept.
    const reloaded = new TokenStore();
    expect(reloaded.verify(token)).toBeUndefined();
    expect(reloaded.get(info.id)?.revokedAt).toBeDefined();
  });

  it('persists renames and tool changes', async () => {
    const store = new TokenStore();
    const { info } = await store.create('laptop', ['imap_search_emails']);
    await store.update(info.id, { name: 'work laptop', tools: ['imap_get_email'] });

    expect(new TokenStore().get(info.id)).toMatchObject({ name: 'work laptop', tools: ['imap_get_email'] });
    await expect(store.update('missing', { name: 'x' })).rejects.toThrow(/not found/);
  });

  it('writes last-used at most once a minute', async () => {
    const store = new TokenStore();
    const { info } = await store.create('laptop', []);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const rename = vi.spyOn(fsp, 'rename');

    store.recordUse(info.id, '10.0.0.1');
    store.recordUse(info.id, '10.0.0.2');
    await vi.advanceTimersByTimeAsync(59 * 1000);
    expect(rename).not.toHaveBeenCalled();
    expect(store.get(info.id)?.lastUsedFrom).toBe('10.0.0.2');

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
    expect(stored()[0]).toMatchObject({ lastUsedFrom: '10.0.0.2' });
    expect(stored()[0].lastUsedAt).toBeDefined();
  });

  it('flush() writes pending last-used times immediately', async () => {
    const store = new TokenStore();
    const { info } = await store.create('laptop', []);
    store.recordUse(info.id, '10.0.0.3');
    await store.flush();
    expect(stored()[0].lastUsedFrom).toBe('10.0.0.3');
  });

  it('refuses to start on an unreadable tokens.json instead of dropping every token', async () => {
    await fsp.mkdir(path.dirname(file()), { recursive: true });
    await fsp.writeFile(file(), '{ not json');
    expect(() => new TokenStore()).toThrow(/Cannot read/);
  });
});
