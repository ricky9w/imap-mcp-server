import { describe, it, expect } from 'vitest';
import { registerTools, READ_ONLY_TOOLS } from '../src/tools/index.js';
import { TOOL_GROUPS, TOOL_PRESETS, HTTP_FORBIDDEN, effectiveTools, type ToolGroup } from '../src/tools/policy.js';

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
