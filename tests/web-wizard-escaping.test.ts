import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import vm from 'vm';

// The wizard renders the account list with innerHTML. Account fields come from
// accounts.json, which MCP tools (imap_add_account / imap_update_account) can
// write, so an agent could otherwise plant markup that runs in the wizard page.
// app.js is a plain browser script: run it against a minimal DOM stand-in and
// inspect the HTML viewAccounts() produces.
async function renderAccounts(accounts: unknown[]): Promise<string> {
  const elements: Record<string, any> = {};
  const element = (id: string) => (elements[id] ??= {
    innerHTML: '',
    classList: { add() {}, remove() {} },
  });
  const sandbox: Record<string, any> = {
    document: { addEventListener() {}, getElementById: element },
    fetch: async () => ({ json: async () => accounts }),
    console,
  };
  vm.runInNewContext(readFileSync(join(process.cwd(), 'public/js/app.js'), 'utf-8'), sandbox);
  await sandbox.viewAccounts();
  return element('accountsTable').innerHTML;
}

describe('wizard account list', () => {
  it('renders account fields as text, not markup', async () => {
    const html = await renderAccounts([{
      id: `a1');alert(1);//`,
      name: '<img src=x onerror=alert(1)>',
      user: '<script>alert(2)</script>',
      host: '"><svg onload=alert(3)>',
    }]);

    expect(html).not.toMatch(/<img|<script|<svg/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;svg onload=alert(3)&gt;');
    // The id never lands inside an inline JS string where quotes would end it.
    expect(html).not.toContain(`a1');alert(1);//'`);
  });

  it('still renders ordinary accounts', async () => {
    const html = await renderAccounts([{ id: 'acc-1', name: 'Work', user: 'me@example.com', host: 'imap.example.com' }]);

    expect(html).toContain('>Work</td>');
    expect(html).toContain('>me@example.com</td>');
    expect(html).toContain('data-account-id="acc-1"');
  });
});
