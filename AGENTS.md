# AGENTS.md

Cross-agent project guide for **imap-mcp-server** — a Model Context Protocol (MCP)
server that gives AI assistants (Claude, ChatGPT, Cursor, …) access to IMAP/SMTP
mailboxes. This file is the shared source of truth for any agent or contributor
working in this repository.

## Architecture

- **Entry point** — `src/index.ts` boots an `McpServer` (MCP SDK) over **stdio**
  and registers all tools via `src/tools/index.ts`. The services come from
  `createServices()` in `src/core.ts`, which every entry point shares.
  `imap-mcp-server serve` starts the HTTP server instead (`src/http/`).
- **HTTP mode** (`src/http/`) — `serve.ts` puts everything on one configurable
  `host:port` (default `127.0.0.1:8765`, plain HTTP; exposure/TLS is the
  user's choice): a Host guard, stateless Streamable HTTP at `POST /mcp`
  (`mcp.ts`: one `McpServer` per request with only the agent token's tools,
  every call audited), and the wizard in admin mode for all other paths.
  `guards.ts` holds bearer/Host/Origin checks, `overrides.ts` the only
  HTTP-vs-stdio tool differences (inline attachments, Drafts-only drafts).
  In optional Access mode require a verified assertion on every MCP request,
  map a user email to its active grant, and require a bearer token for service
  identities. Resolve signing keys only from the configured team domain (see README).
  Agent tokens (`imcp_…`, hashed, `TokenStore`) and the admin token are never
  interchangeable; the `admin` tool group is never grantable over HTTP. The
  audit log (`AuditLog`) records whitelisted argument summaries only
  (`summarizeArgs`) — keep message text, subjects and secrets out of it.
- **Services** (`src/services/`):
  - `ImapService` — IMAP protocol via **`imapflow`**, with connection pooling,
    folder operations, search, fetch, move/delete, append (Sent/Drafts).
  - `SmtpService` — outbound mail via **`nodemailer`**; composes raw MIME and sends.
  - `AccountManager` — account CRUD with **AES-256-CBC** encrypted credential
    storage at `~/.imap-mcp/accounts.json` (key at `~/.imap-mcp/.key`).
    Credentials can be overridden at read time via environment variables keyed
    by the account's normalized name (uppercase, non-alphanumeric → `_`):
    `IMAP_MCP_ACCOUNT_<NAME>_IMAP_USERNAME` / `_IMAP_PASSWORD` and
    `IMAP_MCP_ACCOUNT_<NAME>_SMTP_USERNAME` / `_SMTP_PASSWORD`. Overrides are
    in-memory only (never persisted) and apply only to existing accounts. The
    variables are consumed at startup (constructor): captured into an
    AES-256-encrypted in-memory cache and deleted from `process.env` so the
    plaintext secret does not linger in the environment. An empty credential is
    the marker for "env-managed"; `assertCredentialsResolved`
    (`src/utils/env-credentials.ts`) is called from `ImapService.connect` and
    `SmtpService.createTransporter` and fails with the missing variable's name
    instead of dialing out blank. Keep `envVarName()` in sync with its copy in
    `public/js/app.js` (the wizard is a static asset and cannot import it) —
    `tests/env-credentials.test.ts` asserts the two agree.
  - `SpamService` — disposable/known-spam domain detection.
- **Tools** (`src/tools/`), grouped by area:
  - `account-tools.ts` — add / update / list / remove / connect / disconnect / test.
  - `email-tools.ts` — search, get, latest, send, reply, forward, save draft,
    mark read/unread, delete, bulk delete, move, attachments, upload, threads.
  - `folder-tools.ts` — list, status, create, unread counts.
  - `spam-tools.ts` — spam analysis, domain stats, allow/deny lists.
  - `policy.ts` — every tool in exactly one permission group (`TOOL_GROUPS`),
    presets, and the tools never grantable over HTTP. **Classify each new
    tool there**; `tests/tool-policy.test.ts` fails otherwise.
  - `registry.ts` — captures the tool definitions once so a server can be
    built with only an allowed subset; keep its registrar calls in sync with
    `registerTools()`.
- **Web setup wizard** — `src/web/server.ts` (Express) serves `public/` for
  account onboarding (`npm run setup` / `imap-setup`). Binds `127.0.0.1` and
  rejects non-loopback `Host`/`Origin`. With `--host` / `IMAP_MCP_BIND` beyond
  loopback, every request needs the per-start access token instead (cookie or
  `Authorization: Bearer`); keep both paths covered when touching middleware.
  `server.ts` must stay free of import side effects — esbuild inlines it into
  other entries; the standalone entry (`npm run web`) is `src/web/main.ts`.
  With `admin` deps (passed by `serve`) it runs in admin mode: the admin token
  is always required, and it adds the token, catalog and audit API. Its views
  live in `public/js/admin.js`, which builds the DOM with `createElement` /
  `textContent` only (token names and audit details are agent-controlled);
  `tests/admin-ui-static.test.ts` fails on any HTML sink there.
- **Agent CLI** (`src/cli/`, bin `imap-mcp-cli` → `dist/cli.js`) — an MCP
  client of `serve`'s `/mcp`, so auth, permissions and audit are identical.
  The token comes from `IMAP_MCP_TOKEN` only (never a flag); stdout is the
  tool's JSON, errors are JSON on stderr; exit codes 0 ok / 1 tool error or
  `success:false` / 2 usage / 3 unauthorized or not permitted / 4 network.
  Policy refusals (`ToolDeniedError` in `src/http/`) come back as error
  results marked with `_meta[DENIED_META_KEY]` (`src/utils/denied.ts`), which
  the CLI maps to exit 3 — throw that error rather than inventing messages.
  `index.ts` exports `runCli()` (no side effects); `main.ts` is the entry.
  Aliases live in `commands.ts`; `tests/cli.test.ts` checks their tools exist.
- **Agent skill** — `skills/imap-mail/SKILL.md` (+ `reference/cli.md`), shipped
  in the package. When tools, CLI commands or options change, update it;
  `tests/skill-doc.test.ts` fails on names that do not exist.
- **Examples** — `examples/systemd/` and `examples/docker/`: optional,
  minimal service examples for `serve`; nothing depends on them.
- **Types** — `src/types/index.ts`.
- All tools return **JSON-formatted text** content; errors are returned as
  structured JSON where practical rather than thrown for caller-facing failures.

## Build / Test commands

```bash
npm install          # install dependencies
npm run build        # bundle to dist/ via esbuild (build.mjs)
npm test             # run the vitest suite (run mode)
npm run test:watch   # vitest in watch mode
npm run lint         # tsc --noEmit type-check
npm run dev          # run the server from source (tsx watch)
npm run setup        # launch the web setup wizard
```

Always run `npm run build` **and** `npm test` before committing changes that
touch `src/`. Keep the suite green (currently 582 tests).

> Note: `npm run lint` (`tsc --noEmit`) is memory-hungry on this project — the
> MCP SDK's `registerTool` generics are deep enough to surface a pre-existing
> `TS2589` and can OOM on low-RAM machines. Run it with a larger heap if needed
> (`node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc --noEmit`).

## Security rules (must follow)

1. **Never log secrets.** Passwords, encryption keys, `accounts.json` contents,
   raw auth tokens, and full message bodies must not be written to stdout/stderr
   or to disk outside the user's mailbox/download directories. When adding logs,
   log identifiers (account id, folder, uid), not credentials.
2. **No destructive mail operations without explicit guard logic.** Deletes,
   bulk deletes, and moves must be driven by explicit caller input. Bulk/criteria
   deletion must keep its `dryRun` path and require concrete criteria — never
   delete a whole folder by default, and never widen a delete beyond what the
   caller specified.
3. **Tool schema changes require docs + tests.** Do not rename existing tools or
   change their input/output shape without (a) updating the tool `description`,
   (b) updating `README.md`, and (c) adding/adjusting tests. Prefer additive,
   backward-compatible changes (new optional fields) over breaking ones.
4. **Credentials stay local.** Do not add telemetry, analytics, crash reporting,
   or unrelated network calls. Limit outbound traffic to the configured IMAP/SMTP
   servers and, in Access mode, the configured team's HTTPS public signing-key endpoint.
5. **Validate and sanitize file paths** for attachment upload/download (already
   done via `path.basename`); keep writes confined to the configured directories.

## Conventions

- TypeScript, ESM (`"type": "module"`), **Node ≥ 22.12** (declared in
  `package.json` `engines.node`; CI runs 22.x and 24.x).
  - npm checks a dependency's `engines` against the Node doing the *install*,
    not against the floor we declare — so a dependency needing a newer Node
    installs silently and only breaks on a user's older runtime. This is how
    #108 happened. `tests/node-engines.test.ts` walks the runtime dependency
    tree and fails if any package needs more than we advertise. When it fires,
    either raise the floor (CI matrix, AGENTS.md and README with it) or pin the
    package back via npm `overrides`.
- Tool names are stable public API: `imap_*`. Do not rename without a strong
  reason and a migration note.
- Zod schemas describe every tool input; every field gets a `.describe()` that
  tells an LLM **when and how** to use it.
- Match the surrounding code style; keep error handling and connection cleanup
  consistent with existing tools.
