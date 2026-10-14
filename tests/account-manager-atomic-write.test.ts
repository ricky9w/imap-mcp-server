import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp, readdirSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';

// Real filesystem (no fs mock). accounts.json holds every configured account,
// so a save that dies half-way (disk full, crash, a second writer) must never
// leave a truncated file behind: the next start would load no accounts at all.
// AccountManager derives ~/.imap-mcp from os.homedir(), which honours $HOME.
describe('AccountManager atomic saves', () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  const account = (name: string) => ({
    name,
    host: 'imap.test.com',
    port: 993,
    user: `${name}@test.com`,
    password: 'pw',
    tls: true,
  });

  beforeEach(async () => {
    prevHome = process.env.HOME;
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'imap-mcp-atomic-'));
    process.env.HOME = tmpHome;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fsp.rm(tmpHome, { recursive: true, force: true });
  });

  it('keeps the previous accounts.json when a save fails half-way', async () => {
    const { AccountManager } = await import('../src/services/account-manager.js');
    const manager = new AccountManager();
    await manager.addAccount(account('first'));

    const realWriteFile = fsp.writeFile.bind(fsp);
    vi.spyOn(fsp, 'writeFile').mockImplementationOnce((async (file: any, data: any, options: any) => {
      await realWriteFile(file, String(data).slice(0, 10), options);
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }) as any);
    await expect(manager.addAccount(account('second'))).rejects.toThrow('ENOSPC');

    const dir = path.join(tmpHome, '.imap-mcp');
    const stored = JSON.parse(readFileSync(path.join(dir, 'accounts.json'), 'utf-8'));
    expect(stored.map((a: { name: string }) => a.name)).toEqual(['first']);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(new AccountManager().getAllAccounts().map((a) => a.name)).toEqual(['first']);
  });

  it('leaves only the store files behind after successful saves', async () => {
    const { AccountManager } = await import('../src/services/account-manager.js');
    const manager = new AccountManager();
    await manager.addAccount(account('first'));
    await manager.addAccount(account('second'));

    const dir = path.join(tmpHome, '.imap-mcp');
    expect(readdirSync(dir).sort()).toEqual(['.key', 'accounts.json']);
    expect(new AccountManager().getAllAccounts().map((a) => a.name)).toEqual(['first', 'second']);
  });
});
