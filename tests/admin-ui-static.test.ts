import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import vm from 'vm';

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf-8');
const adminJs = read('public/js/admin.js');

// The admin views render agent-controlled text (token names, folder names and
// other tool arguments in the audit log). A single HTML sink would let a
// prompt-injected agent run script with the admin's session.
describe('admin UI sources', () => {
  it('admin.js never builds markup from strings', () => {
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      expect(adminJs, sink).not.toContain(sink);
    }
    expect(() => new vm.Script(adminJs)).not.toThrow();
  });

  it('app.js escapes the account table', () => {
    const appJs = read('public/js/app.js');
    for (const field of ['name', 'user', 'host']) {
      expect(appJs).toContain(`\${escapeHtml(account.${field})}`);
    }
    expect(appJs).not.toMatch(/onclick="\w+\('\$\{account\.id\}'\)"/);
  });

  it('index.html keeps the admin views and buttons hidden until admin.js finds admin mode', () => {
    const html = read('public/index.html');
    expect(html).toContain('<script src="/js/admin.js"></script>');
    for (const id of ['tokensNav', 'auditNav', 'adminViews']) {
      expect(html).toMatch(new RegExp(`id="${id}" class="hidden`));
    }
  });
});

// A minimal DOM stand-in: enough for admin.js, with text kept apart from
// elements so a test can tell markup from text.
class FakeElement {
  children: Array<FakeElement | string> = [];
  attributes: Record<string, string> = {};
  className = '';
  value = '';
  checked = false;
  dataset: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {} };
  constructor(public tagName: string) {}
  append(...nodes: Array<FakeElement | string>) { this.children.push(...nodes); }
  replaceChildren(...nodes: Array<FakeElement | string>) { this.children = nodes; }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
    if (name === 'value') this.value = value;
  }
  addEventListener() {}
  descendants(): FakeElement[] {
    return this.children.flatMap(child => (child instanceof FakeElement ? [child, ...child.descendants()] : []));
  }
  querySelector(tag: string) { return this.descendants().find(node => node.tagName === tag) ?? null; }
  get textContent(): string { return this.children.map(child => (typeof child === 'string' ? child : child.textContent)).join(''); }
  set textContent(value: string) { this.children = [String(value)]; }
}

async function loadAdminJs(responses: Record<string, unknown>) {
  const elements = new Map<string, FakeElement>();
  const byId = (id: string) => {
    if (!elements.has(id)) elements.set(id, new FakeElement('div'));
    return elements.get(id)!;
  };
  let ready: () => Promise<void> = async () => {};
  const sandbox: Record<string, any> = {
    document: {
      addEventListener: (_type: string, handler: () => Promise<void>) => { ready = handler; },
      getElementById: byId,
      createElement: (tag: string) => new FakeElement(tag),
      querySelectorAll: (selector: string) =>
        selector === '.admin-view' ? ['tokensView', 'tokenForm', 'tokenCreated', 'auditView'].map(byId)
          : selector.startsWith('#tokenTools') ? byId('tokenTools').descendants().filter(node => node.tagName === 'input')
            : [],
    },
    fetch: async (url: string) => {
      const key = Object.keys(responses).find(prefix => url.startsWith(prefix));
      return { ok: key !== undefined, status: key ? 200 : 404, json: async () => (key ? responses[key] : {}) };
    },
    window: { location: { origin: 'https://mail.example.com' } },
    URLSearchParams,
    console,
  };
  vm.runInNewContext(adminJs, sandbox);
  await ready();
  return { sandbox, byId };
}

const catalog = {
  tools: [
    { name: 'imap_search_emails', group: 'read', description: 'search' },
    { name: 'imap_send_email', group: 'send', description: 'send' },
  ],
  presets: { readonly: ['imap_search_emails'] },
};
const XSS = '<img src=x onerror=alert(1)>';

describe('admin UI rendering', () => {
  it('shows token names and audit details as text, never as elements', async () => {
    const { sandbox, byId } = await loadAdminJs({
      '/api/tools/catalog': catalog,
      '/api/tokens': [{ id: 'abcdefghij', name: XSS, tools: ['imap_search_emails'], createdAt: '2026-10-15T00:00:00Z' }],
      '/api/audit': [{ ts: '2026-10-15T00:00:01Z', event: 'tool_call', tokenName: XSS, tool: 'imap_search_emails', outcome: 'ok', args: { folder: XSS } }],
    });

    await sandbox.viewTokens();
    await sandbox.loadAudit(true);

    for (const table of [byId('tokensTable'), byId('auditTable')]) {
      expect(table.descendants().some(node => node.tagName === 'img')).toBe(false);
      expect(table.textContent).toContain(XSS);
    }
  });

  it('shows a new token once, with client config for the URL the page was opened with', async () => {
    const { sandbox, byId } = await loadAdminJs({ '/api/tools/catalog': catalog });
    sandbox.showTokenCreated('imcp_abcdefghij_secret');

    expect(byId('tokenSecret').value).toBe('imcp_abcdefghij_secret');
    expect(byId('snippetCli').textContent).toBe(
      'claude mcp add --transport http imap https://mail.example.com/mcp --header "Authorization: Bearer imcp_abcdefghij_secret"'
    );
    expect(JSON.parse(byId('snippetJson').textContent).mcpServers.imap).toEqual({
      type: 'http',
      url: 'https://mail.example.com/mcp',
      headers: { Authorization: 'Bearer imcp_abcdefghij_secret' },
    });
  });

  it('stays inactive when the server is not in admin mode', async () => {
    const { byId } = await loadAdminJs({});
    expect(byId('tokenTools').children).toEqual([]);
  });
});
