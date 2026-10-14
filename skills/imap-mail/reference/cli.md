# imap-mcp-cli reference

`imap-mcp-cli` is a JSON command-line client for `imap-mcp-server serve`. It
calls the same `/mcp` endpoint as MCP clients, with the same permissions and
the same audit log.

## Setup

```bash
export IMAP_MCP_URL=http://127.0.0.1:8765/mcp   # the MCP endpoint
export IMAP_MCP_TOKEN=imcp_…                    # an agent token
```

The token is read **only** from `IMAP_MCP_TOKEN`; no option accepts it, so it
never shows up in `ps` or shell history. `--url` overrides `IMAP_MCP_URL`.

## Commands

| Command | Tool | Options |
| --- | --- | --- |
| `imap-mcp-cli tools` | `tools/list` | — |
| `imap-mcp-cli call <tool> [json]` | any tool | arguments as a JSON object |
| `imap-mcp-cli accounts` | `imap_list_accounts` | — |
| `imap-mcp-cli folders` | `imap_list_folders` | `--account <name>` |
| `imap-mcp-cli latest` | `imap_get_latest_emails` | `--account`, `--folder`, `--count <n>`, `--include-body` |
| `imap-mcp-cli search` | `imap_search_emails` | `--account`, `--folder`, `--from`, `--to`, `--subject`, `--body`, `--since <YYYY-MM-DD>`, `--before <YYYY-MM-DD>`, `--unseen`, `--limit <n>` |
| `imap-mcp-cli get <uid>` | `imap_get_email` | `--account`, `--folder`, `--format <markdown\|text\|html\|auto>` |
| `imap-mcp-cli mark-read <uid...>` | `imap_mark_as_read` | `--account`, `--folder` |
| `imap-mcp-cli attachment <uid> <filename>` | `imap_download_attachment` | `--out <file>` (required), `--account`, `--folder` |

- **`--folder`** defaults to `INBOX`.
- **`--account`** is needed only when several accounts exist.
- **Other tools:** call them with `call`. Their argument names are in
  `imap-mcp-cli tools`.

## Output

- **stdout** is the tool's JSON, compact by default; add `--pretty` to indent it.
- **attachment** writes the file to `--out` and prints its details
  (`savedTo`, `size`, `contentType`, plus the extracted `textContent` for PDFs).
- **Errors** go to stderr as one JSON object:

  ```json
  {"error":{"type":"denied","message":"Tool imap_send_email is not available to this token."}}
  ```

| Exit code | `type` | Meaning |
| --- | --- | --- |
| 0 | — | ok |
| 1 | `tool` | the tool failed, or returned `success:false` (its JSON is still printed) |
| 2 | `usage` | bad arguments, or `IMAP_MCP_URL` / `IMAP_MCP_TOKEN` missing |
| 3 | `auth` / `denied` | token invalid or revoked / tool not available to this token, or the server refused this use of it by policy (e.g. a draft outside the Drafts folder) |
| 4 | `network` | the server cannot be reached, or answered with an HTTP error |

## Examples

```bash
imap-mcp-cli latest --count 5 | jq '.messages[] | {uid, from, subject}'
imap-mcp-cli search --subject invoice --since 2026-10-01 --limit 20
imap-mcp-cli get 4711 --format text | jq -r '.email.textContent'
imap-mcp-cli mark-read 4711 4712
imap-mcp-cli attachment 4711 report.pdf --out ./report.pdf
imap-mcp-cli call imap_find_thread_messages '{"sourceFolder":"Projects","searchFolder":"INBOX"}'
```
