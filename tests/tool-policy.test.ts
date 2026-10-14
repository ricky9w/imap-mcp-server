import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools, READ_ONLY_TOOLS } from '../src/tools/index.js';
import { TOOL_GROUPS, TOOL_PRESETS, HTTP_FORBIDDEN, effectiveTools, type ToolGroup } from '../src/tools/policy.js';
import { collectToolDefinitions, applyToolDefinitions, type ToolDefinition } from '../src/tools/registry.js';

/** Every tool name registerTools() registers when nothing restricts it. */
function registeredToolNames(): string[] {
  const names: string[] = [];
  const stub: any = {};
  registerTools({ registerTool: (name: string) => names.push(name) } as any, stub, stub, stub, stub);
  return names;
}

const groupOf = (tool: string): ToolGroup[] =>
  (Object.keys(TOOL_GROUPS) as ToolGroup[]).filter(group =>
    (TOOL_GROUPS[group] as readonly string[]).includes(tool)
  );

describe('TOOL_GROUPS', () => {
  it('classifies every registered tool in exactly one group', () => {
    const tools = registeredToolNames();
    expect(tools).toHaveLength(40);

    const unclassified = tools.filter(tool => groupOf(tool).length === 0);
    expect(unclassified, 'New tool(s) without a group — add each to one group in src/tools/policy.ts TOOL_GROUPS').toEqual([]);

    const ambiguous = tools.filter(tool => groupOf(tool).length > 1);
    expect(ambiguous, 'Tool(s) listed in more than one group in src/tools/policy.ts').toEqual([]);
  });

  it('lists no tool that is not registered', () => {
    const tools = new Set(registeredToolNames());
    const unknown = Object.values(TOOL_GROUPS).flat().filter(tool => !tools.has(tool));
    expect(unknown).toEqual([]);
  });

  it('matches the stdio read-only subset: read plus imap_disconnect', () => {
    expect(new Set(READ_ONLY_TOOLS)).toEqual(new Set([...TOOL_GROUPS.read, 'imap_disconnect']));
  });

  it('forbids exactly the admin group over HTTP', () => {
    expect(HTTP_FORBIDDEN).toEqual(TOOL_GROUPS.admin);
  });
});

describe('TOOL_PRESETS', () => {
  it('only combine existing groups and never include admin', () => {
    for (const [preset, groups] of Object.entries(TOOL_PRESETS)) {
      for (const group of groups) {
        expect(TOOL_GROUPS, preset).toHaveProperty(group);
      }
      expect(groups, preset).not.toContain('admin');
    }
  });

  it('read_markread is the 15 read tools plus imap_mark_as_read', () => {
    const tools = TOOL_PRESETS.read_markread.flatMap(group => TOOL_GROUPS[group]);
    expect(tools).toHaveLength(16);
    expect(tools).toContain('imap_mark_as_read');
  });
});

describe('effectiveTools', () => {
  const token = ['imap_search_emails', 'imap_mark_as_read', 'imap_send_email', 'imap_update_account', 'imap_disconnect'];

  it('is the token list minus the HTTP-forbidden tools when no ceiling is set', () => {
    expect(effectiveTools(token, {})).toEqual(new Set(['imap_search_emails', 'imap_mark_as_read', 'imap_send_email']));
  });

  it('never grants a forbidden tool, even when the ceiling allows it', () => {
    const allowed = effectiveTools(token, { IMAP_MCP_ENABLED_TOOLS: 'imap_update_account,imap_search_emails' });
    expect(allowed).toEqual(new Set(['imap_search_emails']));
  });

  it('intersects with IMAP_MCP_READ_ONLY when it is set', () => {
    expect(effectiveTools(token, { IMAP_MCP_READ_ONLY: 'true' })).toEqual(new Set(['imap_search_emails']));
  });

  it('intersects with IMAP_MCP_ENABLED_TOOLS, normalized like stdio', () => {
    expect(effectiveTools(token, { IMAP_MCP_ENABLED_TOOLS: 'search_emails, IMAP_SEND_EMAIL' }))
      .toEqual(new Set(['imap_search_emails', 'imap_send_email']));
  });

  it('applies no ceiling when the variables are unset, blank or falsy', () => {
    const expected = new Set(['imap_search_emails', 'imap_mark_as_read', 'imap_send_email']);
    expect(effectiveTools(token, { IMAP_MCP_READ_ONLY: 'false' })).toEqual(expected);
    expect(effectiveTools(token, { IMAP_MCP_ENABLED_TOOLS: '  ', IMAP_MCP_READ_ONLY: '' })).toEqual(expected);
  });

  it('grants nothing for an empty token list', () => {
    expect(effectiveTools([], {})).toEqual(new Set());
  });
});

// Handlers only touch the services when called, so stubs are enough to collect.
const stubServices = (overrides: Record<string, unknown> = {}): any => ({
  imapService: {},
  accountManager: {},
  smtpService: {},
  spamService: {},
  ...overrides,
});

describe('collectToolDefinitions', () => {
  it('captures the same tools, in the same order, as registerTools()', () => {
    const names = collectToolDefinitions(stubServices()).map(definition => definition.name);
    expect(names).toEqual(registeredToolNames());
  });

  it('keeps each registrar config and handler', () => {
    for (const definition of collectToolDefinitions(stubServices())) {
      expect(typeof definition.config.description, definition.name).toBe('string');
      expect(definition.config.inputSchema, definition.name).toBeDefined();
      expect(typeof definition.handler, definition.name).toBe('function');
    }
  });
});

describe('applyToolDefinitions', () => {
  const definitions: ToolDefinition[] = [
    { name: 'imap_a', config: { description: 'a' }, handler: () => 'a' },
    { name: 'imap_b', config: { description: 'b' }, handler: () => 'b' },
    { name: 'imap_c', config: { description: 'c' }, handler: () => 'c' },
  ];

  it('registers only the allowed definitions, with their config and handler', () => {
    const registerTool = vi.fn();
    applyToolDefinitions({ registerTool } as any, definitions, new Set(['imap_c', 'imap_a']));

    expect(registerTool.mock.calls).toEqual([
      ['imap_a', definitions[0].config, definitions[0].handler],
      ['imap_c', definitions[2].config, definitions[2].handler],
    ]);
  });

  it('registers the wrapped handler when a wrapper is given', () => {
    const registerTool = vi.fn();
    const wrapped = () => 'wrapped';
    const wrap = vi.fn(() => wrapped);
    applyToolDefinitions({ registerTool } as any, definitions, new Set(['imap_b']), wrap);

    expect(wrap).toHaveBeenCalledExactlyOnceWith(definitions[1]);
    expect(registerTool).toHaveBeenCalledExactlyOnceWith('imap_b', definitions[1].config, wrapped);
  });

  // The real SDK, end to end: two servers built from one captured list expose
  // only their own allowed tools, and calls reach the wrapped handler.
  it('builds independent servers from one captured list', async () => {
    const collected = collectToolDefinitions(stubServices({ accountManager: { getAllAccounts: () => [] } }));
    const calls: string[] = [];
    const wrap = (definition: ToolDefinition) => (...args: any[]) => {
      calls.push(definition.name);
      return definition.handler(...args);
    };

    const connect = async (allowed: string[]) => {
      const server = new McpServer({ name: 'test', version: '0.0.0' });
      applyToolDefinitions(server, collected, new Set(allowed), wrap);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-client', version: '0.0.0' });
      await client.connect(clientTransport);
      return client;
    };

    const reader = await connect(['imap_list_accounts', 'imap_search_emails']);
    const sender = await connect(['imap_send_email']);

    expect((await reader.listTools()).tools.map(tool => tool.name)).toEqual(['imap_list_accounts', 'imap_search_emails']);
    expect((await sender.listTools()).tools.map(tool => tool.name)).toEqual(['imap_send_email']);

    const result: any = await reader.callTool({ name: 'imap_list_accounts', arguments: {} });
    expect(JSON.parse(result.content[0].text)).toEqual({ accounts: [] });
    expect(calls).toEqual(['imap_list_accounts']);

    await reader.close();
    await sender.close();
  });
});
