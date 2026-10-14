import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { createServices } from '../src/core.js';
import { ImapService } from '../src/services/imap-service.js';
import { AccountManager } from '../src/services/account-manager.js';
import { SmtpService } from '../src/services/smtp-service.js';
import { SpamService } from '../src/services/spam-service.js';

// AccountManager creates ~/.imap-mcp/.key on construction; keep that in a
// throwaway HOME (os.homedir() honours $HOME).
describe('createServices', () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    prevHome = process.env.HOME;
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'imap-mcp-core-'));
    process.env.HOME = tmpHome;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fsp.rm(tmpHome, { recursive: true, force: true });
  });

  it('builds the four services and lets ImapService auto-connect via the account manager', () => {
    const services = createServices();

    expect(services.imapService).toBeInstanceOf(ImapService);
    expect(services.accountManager).toBeInstanceOf(AccountManager);
    expect(services.smtpService).toBeInstanceOf(SmtpService);
    expect(services.spamService).toBeInstanceOf(SpamService);
    expect((services.imapService as any).accountManager).toBe(services.accountManager);
  });
});
