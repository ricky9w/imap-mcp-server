import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ImapService } from '../src/services/imap-service.js';
import type { ImapAccount } from '../src/types/index.js';

// Every login attempt constructs an ImapFlow, so the number of instances is
// the number of times the service dialed the server.
const instances: any[] = [];
let connectResult: () => Promise<void> = () => Promise.resolve();

vi.mock('imapflow', () => ({
  ImapFlow: class {
    usable = true;
    constructor() {
      instances.push(this);
    }
    connect() { return connectResult(); }
    logout() { return Promise.resolve(); }
    on() { /* no-op */ }
  },
}));

// What imapflow throws for a rejected LOGIN/AUTHENTICATE.
const authFailure = () => {
  const err: any = new Error('Command failed');
  err.authenticationFailed = true;
  return Promise.reject(err);
};

const account = (password = 'wrong'): ImapAccount => ({
  id: 'acc',
  name: 'Work',
  host: 'imap.test.com',
  port: 993,
  user: 'user@test.com',
  password,
  tls: true,
});

const start = new Date('2026-10-15T12:00:00Z').getTime();
const at = (seconds: number) => vi.setSystemTime(start + seconds * 1000);

// Without a back-off every tool call, from every session, logs in again with
// the same rejected password, which providers answer with a temporary lockout.
describe('ImapService back-off after rejected logins', () => {
  let service: ImapService;

  beforeEach(() => {
    instances.length = 0;
    connectResult = authFailure;
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    service = new ImapService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not dial again with the same credentials inside the back-off window', async () => {
    await expect(service.connect(account())).rejects.toThrow('Command failed');
    at(10);
    await expect(service.connect(account())).rejects.toThrow(/not retrying for 20s/);
    expect(instances).toHaveLength(1);
  });

  it('retries once the window has passed and doubles it after another failure', async () => {
    await expect(service.connect(account())).rejects.toThrow('Command failed');
    at(31);
    await expect(service.connect(account())).rejects.toThrow('Command failed');
    expect(instances).toHaveLength(2);

    at(31 + 59);
    await expect(service.connect(account())).rejects.toThrow(/not retrying/);
    expect(instances).toHaveLength(2);

    at(31 + 61);
    connectResult = () => Promise.resolve();
    await expect(service.connect(account())).resolves.toBeUndefined();
    expect(instances).toHaveLength(3);
  });

  it('caps the window at ten minutes', async () => {
    let now = 0;
    for (let i = 0; i < 8; i++) {
      await expect(service.connect(account())).rejects.toThrow('Command failed');
      now += 10 * 60 + 1;
      at(now);
    }
    expect(instances).toHaveLength(8);
  });

  it('retries at once when the credentials changed', async () => {
    await expect(service.connect(account('wrong'))).rejects.toThrow('Command failed');
    connectResult = () => Promise.resolve();
    await expect(service.connect(account('fixed'))).resolves.toBeUndefined();
    expect(instances).toHaveLength(2);
  });

  it('does not back off for errors other than a rejected login', async () => {
    connectResult = () => Promise.reject(new Error('connect ECONNREFUSED'));
    await expect(service.connect(account())).rejects.toThrow('ECONNREFUSED');
    await expect(service.connect(account())).rejects.toThrow('ECONNREFUSED');
    expect(instances).toHaveLength(2);
  });

  it('forgets earlier failures after a successful login', async () => {
    await expect(service.connect(account())).rejects.toThrow('Command failed');
    at(31);
    connectResult = () => Promise.resolve();
    await service.connect(account());
    await service.disconnect('acc');

    connectResult = authFailure;
    await expect(service.connect(account())).rejects.toThrow('Command failed');
    // Back to the base window, not a doubled one.
    at(31 + 31);
    await expect(service.connect(account())).rejects.toThrow('Command failed');
    expect(instances).toHaveLength(4);
  });
});
