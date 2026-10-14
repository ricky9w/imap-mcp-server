import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ImapService } from '../src/services/imap-service.js';
import { ImapAccount } from '../src/types/index.js';

// Every ImapFlow the service constructs is recorded here so a test can assert
// that a reconnect builds a FRESH instance instead of reusing a dead one.
const instances: any[] = [];

// A mock that mimics the one ImapFlow invariant that caused the production bug:
// an instance is single-use. Once it has connected, calling .connect() on the
// SAME object again rejects with "Can not re-use ImapFlow instance" (the real
// imapflow error). The service must therefore construct a new instance.
vi.mock('imapflow', () => {
  return {
    ImapFlow: class {
      usable = true;
      connectedOnce = false;
      connectMock = vi.fn().mockResolvedValue(undefined);
      logoutMock = vi.fn().mockResolvedValue(undefined);
      listMock = vi.fn().mockResolvedValue([
        { path: 'INBOX', delimiter: '/', flags: [] },
      ]);
      messageMoveMock = vi.fn().mockResolvedValue({});
      constructor() {
        instances.push(this);
      }
      connect() {
        if (this.connectedOnce) {
          return Promise.reject(new Error('Can not re-use ImapFlow instance'));
        }
        this.connectedOnce = true;
        return this.connectMock();
      }
      logout() { return this.logoutMock(); }
      list() { return this.listMock(); }
      getMailboxLock() { return Promise.resolve({ release: () => {} }); }
      messageMove(...args: any[]) { return this.messageMoveMock(...args); }
      on() { /* no-op */ }
    },
  };
});

describe('ImapService reconnect (ImapFlow instances are single-use)', () => {
  let imapService: ImapService;
  let account: ImapAccount;

  beforeEach(() => {
    instances.length = 0;
    imapService = new ImapService();
    account = {
      id: 'acc',
      name: 'Test',
      host: 'imap.test.com',
      port: 993,
      user: 'user@test.com',
      password: 'pw',
      tls: true,
    };
  });

  it('rebuilds a fresh ImapFlow when the live connection went stale', async () => {
    await imapService.connect(account);
    expect(instances).toHaveLength(1);

    // Simulate an idle-timeout drop between two tool calls: the client object is
    // still cached but no longer usable.
    instances[0].usable = false;

    // The next operation must transparently reconnect. With the old code this
    // called .connect() on the dead instance and threw
    // "Failed to reconnect: Can not re-use ImapFlow instance".
    const folders = await imapService.listFolders(account.id);

    expect(folders).toHaveLength(1);
    // A brand-new instance was constructed and used (not the dead one reused).
    expect(instances).toHaveLength(2);
    expect(instances[1].usable).toBe(true);
    expect(instances[1].connectedOnce).toBe(true);
  });

  it('does not throw the "Can not re-use ImapFlow instance" error on reconnect', async () => {
    await imapService.connect(account);
    instances[0].usable = false;

    await expect(imapService.listFolders(account.id)).resolves.toBeDefined();
  });

  // After a failed chunk bulkDelete marks the connection dead and reconnects
  // before the next chunk, but it kept moving messages through the client it
  // had captured at the start, so every later chunk went to the dead one.
  it('bulkDelete moves the remaining chunks through the reconnected client', async () => {
    await imapService.connect(account);
    instances[0].messageMoveMock.mockImplementationOnce(() => {
      instances[0].usable = false;
      return Promise.reject(new Error('Connection lost'));
    });

    const result = await imapService.bulkDelete(account.id, 'INBOX', [1, 2, 3, 4], 2);

    expect(instances).toHaveLength(2);
    expect(instances[0].messageMoveMock).toHaveBeenCalledTimes(1);
    expect(instances[1].messageMoveMock).toHaveBeenCalledWith('3,4', 'Trash', { uid: true });
    expect(result.deleted).toBe(2);
    expect(result.failed).toBe(2);
  });
});
