import { describe, it, expect, vi } from 'vitest';
import net from 'net';
import path from 'path';

// Keep a regression free of side effects: no key file, no browser.
vi.mock('../src/services/account-manager.js', () => ({ AccountManager: class {} }));
vi.mock('open', () => ({ default: vi.fn() }));

// server.ts used to start a wizard itself whenever import.meta.url matched
// argv[1]. Once esbuild inlines it into another entry (dist/setup.js), that
// check is true for the bundle, so `node dist/setup.js --host 0.0.0.0` brought
// up a second, token-less wizard on 127.0.0.1:$PORT next to the one setup
// started. Importing the module must never start a server, whatever argv[1] is.
describe('web/server.ts import', () => {
  it('does not start a server even when argv[1] points at the module', async () => {
    const listen = vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function (this: net.Server) {
      return this;
    });
    const savedArgv1 = process.argv[1];
    process.argv[1] = path.resolve('src/web/server.ts');
    let listenCalls: number;
    try {
      await import('../src/web/server.js');
      listenCalls = listen.mock.calls.length;
    } finally {
      process.argv[1] = savedArgv1;
      listen.mockRestore();
    }
    expect(listenCalls).toBe(0);
  });
});
