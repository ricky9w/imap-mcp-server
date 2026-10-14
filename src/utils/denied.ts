/**
 * `_meta` key the HTTP endpoint sets on a tool result when it refuses a call
 * by policy (a tool the token may not use, or e.g. a draft outside the Drafts
 * folder), so clients such as imap-mcp-cli can tell a refusal from a failed
 * operation without parsing the message.
 */
export const DENIED_META_KEY = 'imap-mcp-server/denied';
