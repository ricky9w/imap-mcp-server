import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ImapService } from '../src/services/imap-service.js';
import type { ImapAccount } from '../src/types/index.js';

// One ImapService can serve several MCP sessions, so tool calls for the same
// account overlap. Every ImapFlow the service builds is recorded here so a test
// can tell how many connections were opened.
const instances: any[] = [];

vi.mock('imapflow', () => ({
  ImapFlow: class {
    usable = true;
    loggedOut = false;
    handlers: Record<string, (...args: any[]) => void> = {};
    constructor() {
      instances.push(this);
    }
    connect() {
      // Resolve on a later tick so overlapping callers really overlap.
      return new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    logout() {
      this.loggedOut = true;
      this.usable = false;
      return Promise.resolve();
    }
    list() {
      return Promise.resolve([{ path: 'INBOX', delimiter: '/', flags: new Set() }]);
    }
    on(event: string, handler: (...args: any[]) => void) {
      this.handlers[event] = handler;
    }
  },
}));

const account: ImapAccount = {
  id: 'acc',
  name: 'Shared',
  host: 'imap.test.com',
  port: 993,
  user: 'user@test.com',
  password: 'pw',
  tls: true,
};

describe('ImapService under overlapping tool calls', () => {
  let service: ImapService;

  beforeEach(() => {
    instances.length = 0;
    service = new ImapService();
    service.setAccountManager({ getAccount: () => account } as any);
  });

  // Each overlapping caller used to build its own ImapFlow; all but the last
  // one stored stayed logged in and leaked (counting against the provider's
  // connection limit).
  it('opens a single connection when calls for a cold account overlap', async () => {
    await Promise.all([
      service.listFolders('acc'),
      service.listFolders('acc'),
      service.listFolders('acc'),
    ]);

    expect(instances).toHaveLength(1);
  });

  it('replaces a dead connection exactly once when calls overlap', async () => {
    await service.listFolders('acc');
    instances[0].usable = false;

    await Promise.all([service.listFolders('acc'), service.listFolders('acc')]);

    expect(instances).toHaveLength(2);
    expect(instances[1].loggedOut).toBe(false);
    // Later calls keep using the replacement instead of dialing again.
    await service.listFolders('acc');
    expect(instances).toHaveLength(2);
  });

  // The dead client's 'close' can fire after it was replaced. It used to mark
  // whatever state the account had by then, so the next call tore down the
  // healthy replacement and dialed yet again.
  it('ignores a late close from a connection it already replaced', async () => {
    await service.listFolders('acc');
    instances[0].usable = false;
    await service.listFolders('acc');
    expect(instances).toHaveLength(2);

    instances[0].handlers.close();
    await service.listFolders('acc');

    expect(instances).toHaveLength(2);
    expect(instances[1].loggedOut).toBe(false);
  });
});
