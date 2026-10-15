import { describe, it, expect } from 'vitest';
import { getProviderByEmail } from '../src/providers/email-providers.js';

describe('NetEase providers', () => {
  it.each([
    ['user@163.com', 'imap.163.com', 'smtp.163.com'],
    ['user@126.com', 'imap.126.com', 'smtp.126.com'],
    ['user@yeah.net', 'imap.yeah.net', 'smtp.yeah.net'],
  ])('%s uses per-domain hosts', (email, imap, smtp) => {
    const p = getProviderByEmail(email);
    expect(p?.imapHost).toBe(imap);
    expect(p?.smtpHost).toBe(smtp);
    expect(p?.imapPort).toBe(993);
    expect(p?.smtpPort).toBe(465);
  });
});
