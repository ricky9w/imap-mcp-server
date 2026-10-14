import { resolveEnabledTools } from './index.js';

/**
 * Every tool, classified by what it can do to a mailbox or the server. Agent
 * tokens grant explicit tool names; the groups back the presets and keep the
 * classification reviewable. tests/tool-policy.test.ts fails when a tool is
 * registered but not listed here — classify new tools in exactly one group.
 */
export const TOOL_GROUPS = {
  // Read mail, folders and local config; never change a mailbox.
  read: [
    'imap_list_accounts',
    'imap_connect',
    'imap_test_account',
    'imap_search_emails',
    'imap_get_email',
    'imap_get_latest_emails',
    'imap_download_attachment',
    'imap_find_thread_messages',
    'imap_find_email_by_message_id',
    'imap_list_folders',
    'imap_folder_status',
    'imap_get_unread_count',
    'imap_check_spam',
    'imap_domain_stats',
    'imap_list_spam_domains',
  ],
  mark_read: ['imap_mark_as_read'],
  flag: [
    'imap_mark_as_unread',
    'imap_flag_email',
    'imap_unflag_email',
    'imap_add_keyword',
    'imap_remove_keyword',
  ],
  organize: ['imap_move_email', 'imap_create_folder'],
  draft: ['imap_save_draft', 'imap_upload_file'],
  send: ['imap_send_email', 'imap_reply_to_email', 'imap_forward_email'],
  delete: [
    'imap_delete_email',
    'imap_bulk_delete',
    'imap_bulk_delete_by_search',
    'imap_delete_spam',
    'imap_delete_by_domain',
  ],
  // Change the process-wide spam lists, which affect every session.
  spam_lists: ['imap_add_spam_domain', 'imap_remove_spam_domain', 'imap_add_whitelist_domain'],
  // Account changes can point stored credentials at another host;
  // imap_disconnect drops the connection other sessions share.
  admin: ['imap_add_account', 'imap_update_account', 'imap_remove_account', 'imap_disconnect'],
} as const satisfies Record<string, readonly string[]>;

export type ToolGroup = keyof typeof TOOL_GROUPS;

/** Tools no agent token can be granted over HTTP: the `admin` group. */
export const HTTP_FORBIDDEN: readonly string[] = TOOL_GROUPS.admin;

/** Named group combinations for filling in a token's tool list. */
export const TOOL_PRESETS: Record<string, readonly ToolGroup[]> = {
  readonly: ['read'],
  read_markread: ['read', 'mark_read'],
  triage: ['read', 'mark_read', 'flag', 'organize'],
  // Agents write drafts; a human sends them.
  assistant: ['read', 'mark_read', 'flag', 'organize', 'draft'],
};

export interface ToolCatalog {
  tools: Array<{ name: string; group: ToolGroup; description: string }>;
  /** Each preset expanded to its tool names. */
  presets: Record<string, string[]>;
}

/**
 * What an agent token can be granted, for the admin API: every registered and
 * classified tool except HTTP_FORBIDDEN, with its group and description.
 */
export function toolCatalog(definitions: ReadonlyArray<{ name: string; config: { description?: string } }>): ToolCatalog {
  const groups = Object.keys(TOOL_GROUPS) as ToolGroup[];
  const tools = definitions.flatMap(({ name, config }) => {
    const group = groups.find(g => (TOOL_GROUPS[g] as readonly string[]).includes(name));
    return group && !HTTP_FORBIDDEN.includes(name) ? [{ name, group, description: config.description ?? '' }] : [];
  });
  const grantable = new Set(tools.map(tool => tool.name));
  const presets = Object.fromEntries(
    Object.entries(TOOL_PRESETS).map(([preset, presetGroups]) => [
      preset,
      presetGroups.flatMap(group => TOOL_GROUPS[group]).filter(name => grantable.has(name)),
    ])
  );
  return { tools, presets };
}

/**
 * The tools a token may use: its own list, minus HTTP_FORBIDDEN, narrowed by
 * IMAP_MCP_ENABLED_TOOLS / IMAP_MCP_READ_ONLY only when one of them is set
 * explicitly — a token grants nothing by default, so unlike stdio there is no
 * implicit ceiling.
 */
export function effectiveTools(
  tokenTools: Iterable<string>,
  env: NodeJS.ProcessEnv = process.env
): Set<string> {
  const explicit = Boolean(env.IMAP_MCP_ENABLED_TOOLS?.trim() || env.IMAP_MCP_READ_ONLY?.trim());
  const ceiling = explicit ? resolveEnabledTools(env) : null;

  const allowed = new Set<string>();
  for (const name of tokenTools) {
    if (HTTP_FORBIDDEN.includes(name)) continue;
    if (ceiling && !ceiling.has(name)) continue;
    allowed.add(name);
  }
  return allowed;
}
