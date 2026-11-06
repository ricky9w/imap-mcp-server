# Security Policy

`imap-mcp-server` connects AI assistants to your email. Because email is highly
sensitive, the project is designed to keep your data **local and under your
control**.

## Security model

- **Local execution.** By default the server runs on your own machine as a
  local MCP process (stdio). It is not a hosted service and does not require
  any account with this project.
- **Remote mode (optional).** `imap-mcp-server serve` offers the tools over
  plain HTTP on one `host:port` (default `127.0.0.1:8765`).
  - **Exposure is yours to secure.** The server provides no TLS; how it is
    exposed beyond that address, and with what TLS, is up to you.
  - **Agent tokens** (`imcp_…`) authenticate `POST /mcp`. Only their SHA-256
    is stored (`~/.imap-mcp/tokens.json`, 0600). Each token grants an
    explicit tool list, and revoking it takes effect on the next request.
  - **Managed OAuth** can be enabled for a dedicated Cloudflare Access application on
    `/mcp`. In this mode every request needs a signed assertion for the configured issuer
    and audience. An authenticated email needs an explicit tool grant. Service assertions
    still require an agent token. The deployment host refreshes the public verification
    keys. See [setup and key rotation](README.md#cloudflare-access-managed-oauth).
  - **Never grantable over HTTP:** the account tools, which could point stored
    credentials at another host, and `imap_disconnect`.
  - **The admin token** protects every other path, i.e. the admin UI and API.
    It comes from `IMAP_MCP_WIZARD_TOKEN` or `~/.imap-mcp/admin-token` (0600)
    and is never printed. The two kinds of token are not interchangeable.
  - **Audit log:** every tool call, failed authentication, token change and
    account change goes to `~/.imap-mcp/audit.log` (0600). Entries hold
    identifiers and full outbound recipient lists, never message text,
    subjects, credentials or tokens.
- **Prompt injection.** Email is written by third parties. A crafted message
  can try to make an agent forward mail or act on its behalf. Tokens are
  least-privilege by design: prefer presets without sending (`assistant`
  drafts, you send). Agents should load `skills/imap-mail/SKILL.md`, which
  treats all email content as untrusted.
- **Credential storage.** IMAP/SMTP credentials are stored encrypted with
  **AES-256-CBC** in `~/.imap-mcp/accounts.json`. The encryption key is generated
  locally and kept at `~/.imap-mcp/.key`. The store directory and both files are
  written owner-only (`0700`/`0600`) so other local users cannot read them;
  anyone who can read both files can read your credentials.
- **No telemetry.** The server collects no analytics, usage data, or crash
  reports.
- **No third-party data sharing.** The only outbound network connections are to
  the IMAP and SMTP servers **you** configure. Email content and credentials are
  never sent anywhere else.
- **Your MCP client sees your mail.** Email content returned by these tools is
  passed to whichever MCP client/LLM you connect (e.g. Claude, ChatGPT, Cursor).
  Review that client's own privacy terms; treat any connected model as a party
  that can read the mailboxes you expose.

## Recommendations for users

- Use **app-specific passwords** where your provider supports them (Gmail,
  iCloud, Yahoo, Fastmail, …) instead of your primary password.
- Keep `~/.imap-mcp/` readable only by your user account.
- Prefer least-privilege accounts/folders when possible.
- In remote mode:
  - keep the server on loopback behind a TLS-terminating proxy or tunnel;
  - give each agent its own token with only the tools it needs;
  - revoke tokens you no longer use;
  - review the audit log now and then.
- Be deliberate with destructive tools (`imap_delete_email`,
  `imap_bulk_delete`, `imap_bulk_delete_by_search`) — use the `dryRun` option to
  preview criteria-based deletions first. `imap_bulk_delete_by_search` requires
  at least one concrete criterion and refuses an empty criteria set, so it can
  never wipe a whole folder by accident.

## Reporting a vulnerability (responsible disclosure)

If you discover a security issue, please report it **privately** — do not open a
public issue with exploit details.

- **Preferred:** use GitHub's **[Report a vulnerability](https://github.com/nikolausm/imap-mcp-server/security/advisories/new)**
  (Security → Advisories) to open a private advisory. Private vulnerability
  reporting is enabled on this repository, so this form works and routes the
  report only to the maintainer.
- **By email:** write to **security.imap-mcp-server@minicon.eu**. Please do not
  include exploit details in an unencrypted first email if you can avoid it —
  a heads-up plus a request for a secure channel is enough to get started.
- **If neither is available to you:** open a regular GitHub issue that says only
  that you have a security report and asks for a private contact channel —
  **without** any details, reproduction steps, or exploit information. The
  maintainer will follow up privately.

Please include reproduction steps and affected versions in the private report.
We aim to acknowledge reports promptly, investigate, and ship a fix with a
coordinated disclosure once a patch is available. Thank you for helping keep
users safe.
