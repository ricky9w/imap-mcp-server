import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomBytes, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import open from 'open';
import { AccountManager } from '../services/account-manager.js';
import { ImapService } from '../services/imap-service.js';
import type { SmtpService } from '../services/smtp-service.js';
import type { TokenStore } from '../services/token-store.js';
import type { AuditEvent, AuditLog } from '../services/audit-log.js';
import type { ToolCatalog } from '../tools/policy.js';
import { emailProviders, getProviderByEmail } from '../providers/email-providers.js';
import { ImapAccount } from '../types/index.js';
import { PACKAGE_VERSION } from '../utils/version.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const TOKEN_COOKIE = 'imap_wizard_token';
const MIN_TOKEN_LENGTH = 16;

/** What `serve` adds to the wizard to run it as the long-lived admin backend. */
export interface AdminDeps {
  accessEnabled?: boolean;
  tokenStore: TokenStore;
  auditLog: AuditLog;
  /** The tools agent tokens can be granted (see toolCatalog()). */
  catalog: ToolCatalog;
  /** Origins accepted besides same-origin requests (IMAP_MCP_ALLOWED_ORIGINS). */
  allowedOrigins?: string[];
}

/** Where admin mode keeps its generated admin token (owner-only). */
export const adminTokenFile = (): string => path.join(os.homedir(), '.imap-mcp', 'admin-token');

/**
 * The persisted admin token, generated on first use. Kept next to the key in
 * ~/.imap-mcp (0600) so a long-running server keeps it across restarts and
 * never has to print it.
 */
function loadOrCreateAdminToken(file: string): string {
  try {
    const existing = fs.readFileSync(file, 'utf-8').trim();
    if (existing) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const token = randomBytes(24).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
  return token;
}

const originOf = (value: string): string | undefined => {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return undefined;
  }
};

/** Read one cookie value from a raw `Cookie` header. */
function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx !== -1 && part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return undefined; // malformed %-escape: treat as no cookie
      }
    }
  }
  return undefined;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Strip credentials before an account crosses the wizard's HTTP boundary. The
// API is unauthenticated and CORS-open, so any local page could otherwise read
// plaintext IMAP/SMTP passwords out of a response. Returns a shallow copy with
// `password` and `smtp.password` removed.
function stripAccountSecrets<T extends Record<string, any>>(account: T): Omit<T, 'password'> {
  const { password: _password, ...rest } = account;
  const safe: Record<string, any> = { ...rest };
  if (safe.smtp && typeof safe.smtp === 'object' && 'password' in safe.smtp) {
    safe.smtp = { ...safe.smtp };
    delete safe.smtp.password;
  }
  return safe as Omit<T, 'password'>;
}

export class WebUIServer {
  private app: express.Application;
  private accountManager: AccountManager;
  private imapService: ImapService;
  private smtpService?: SmtpService;
  private admin?: AdminDeps;
  private port: number;
  private bindHost: string;
  /** Set when bound beyond loopback, and always in admin mode: required on every request then. */
  private accessToken?: string;
  private accessTokenGenerated = false;

  constructor(
    port: number = 3000,
    deps: {
      accountManager?: AccountManager;
      imapService?: ImapService;
      smtpService?: SmtpService;
      bindHost?: string;
      accessToken?: string;
      /** Admin mode (`serve`): auth always required, plus the token/audit API. */
      admin?: AdminDeps;
    } = {},
  ) {
    this.app = express();
    this.port = port;
    this.admin = deps.admin;
    // Loopback by default: the wizard's API can rewrite account settings, so it
    // must not be reachable from the network unless the user asks for it
    // (IMAP_MCP_BIND / imap-setup --host). Remote mode then requires a token.
    this.bindHost = deps.bindHost?.trim() || process.env.IMAP_MCP_BIND?.trim() || '127.0.0.1';
    if (this.admin) {
      // A long-running admin backend requires the admin token wherever it is
      // bound; a generated one is persisted rather than printed.
      this.accessToken = deps.accessToken?.trim() || process.env.IMAP_MCP_WIZARD_TOKEN?.trim() || loadOrCreateAdminToken(adminTokenFile());
      if (this.accessToken.length < MIN_TOKEN_LENGTH || this.accessToken.startsWith('imcp_')) {
        throw new Error(
          `IMAP_MCP_WIZARD_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters and must not be an agent token (imcp_…).`,
        );
      }
    } else if (this.isRemote()) {
      this.accessToken = deps.accessToken?.trim() || process.env.IMAP_MCP_WIZARD_TOKEN?.trim();
      if (this.accessToken && this.accessToken.length < MIN_TOKEN_LENGTH) {
        throw new Error(
          `IMAP_MCP_WIZARD_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters when the wizard is reachable from the network.`,
        );
      }
      if (!this.accessToken) {
        this.accessToken = randomBytes(24).toString('base64url');
        this.accessTokenGenerated = true;
      }
    }
    this.accountManager = deps.accountManager ?? new AccountManager();
    this.imapService = deps.imapService ?? new ImapService();
    this.smtpService = deps.smtpService;

    this.setupMiddleware();
    this.setupRoutes();
    if (this.admin) {
      this.setupAdminRoutes(this.admin);
    }
  }

  /** The configured Express application. Exposed for tests. */
  getApp(): express.Application {
    return this.app;
  }

  /** True when bound to something other than a loopback address. */
  isRemote(): boolean {
    return !LOOPBACK_HOSTS.has(this.bindHost.toLowerCase());
  }

  /**
   * URL to open the wizard. In remote mode it carries a generated access token
   * so the user can paste it into a browser on another machine; a token taken
   * from IMAP_MCP_WIZARD_TOKEN is not echoed, the user already knows it.
   */
  getAccessUrl(forLocalBrowser = false): string {
    const wildcard = this.bindHost === '0.0.0.0' || this.bindHost === '::';
    const host = !this.isRemote() || (wildcard && forLocalBrowser)
      ? 'localhost'
      : wildcard ? os.hostname() : this.bindHost;
    const hostPart = host.includes(':') ? `[${host}]` : host;
    const query = this.accessTokenGenerated ? `?token=${this.accessToken}` : '';
    return `http://${hostPart}:${this.port}/${query}`;
  }

  private setupMiddleware(): void {
    // The setup wizard is unauthenticated and CORS-open, so it must never be
    // reachable by anything other than the local user's own browser. Reject
    // any request whose Host is not a loopback name (blocks DNS-rebinding, where
    // a malicious site points its own domain at 127.0.0.1) and any cross-origin
    // browser request (Origin set to a non-loopback origin). Together with
    // stripAccountSecrets this closes the "any open page can read/modify the
    // local accounts API" vector.
    if (this.admin) {
      // Admin mode: the serve app already checks Host; every request needs
      // the admin token, and a state-changing API call that carries a body
      // must be JSON so a cross-site form can never submit one (forms always
      // send a Content-Type). A body-less call such as a revoke needs none.
      this.app.use(WebUIServer.securityHeaders());
      this.app.use(this.tokenRequired());
      this.app.use((req, res, next) => {
        const mutating = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
        const contentType = req.headers['content-type'];
        const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
        if (mutating && req.path.startsWith('/api/') && (hasBody || contentType !== undefined) && !/^application\/json\b/i.test(contentType ?? '')) {
          res.status(415).json({ error: 'Content-Type must be application/json.' });
          return;
        }
        next();
      });
    } else if (this.isRemote()) {
      // Reachable from the network on purpose: Host is no longer a usable
      // signal, so every request must carry the access token instead.
      this.app.use(this.tokenRequired());
    } else {
      this.app.use(this.loopbackOnly());
      this.app.use(cors());
    }
    this.app.use(bodyParser.json());
    this.app.use(express.static(this.resolvePublicDir()));
  }

  // Admin mode: no framing, no MIME sniffing, and scripts/connections only from
  // this origin. Styles, fonts and provider icons come from the CDNs the page
  // already uses; the existing page needs inline handlers and styles.
  private static securityHeaders(): express.RequestHandler {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
      'font-src https://cdnjs.cloudflare.com',
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    return (_req, res, next) => {
      res.setHeader('Content-Security-Policy', csp);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      next();
    };
  }

  private static isLoopbackName(name: string): boolean {
    const n = name.toLowerCase();
    return n === 'localhost' || n === '127.0.0.1' || n === '::1';
  }

  // Guard: allow only loopback Host + (when present) loopback Origin. Non-browser
  // clients (curl, tests) send no Origin and are allowed if the Host is loopback.
  private loopbackOnly(): express.RequestHandler {
    const hostname = (hostHeader: string): string =>
      hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');

    return (req, res, next) => {
      const host = req.headers.host;
      if (!host || !WebUIServer.isLoopbackName(hostname(host))) {
        res.status(403).json({ error: 'Forbidden: the setup API is reachable on loopback only.' });
        return;
      }

      const origin = req.headers.origin;
      if (origin) {
        let originHost: string;
        try {
          originHost = new URL(origin).hostname;
        } catch {
          res.status(403).json({ error: 'Forbidden: invalid Origin.' });
          return;
        }
        if (!WebUIServer.isLoopbackName(originHost)) {
          res.status(403).json({ error: 'Forbidden: cross-origin requests are not allowed.' });
          return;
        }
      }

      next();
    };
  }

  private tokenMatches(candidate: string): boolean {
    const expected = Buffer.from(this.accessToken ?? '');
    const given = Buffer.from(candidate);
    return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
  }

  // Remote mode: accept the token once via ?token= (then kept in an HttpOnly,
  // SameSite=Strict cookie so the wizard's own fetches carry it), or on every
  // request as `Authorization: Bearer <token>` for scripted use. Cross-origin
  // browser requests are refused as well.
  private tokenRequired(): express.RequestHandler {
    return (req, res, next) => {
      const deny = (status: number, message: string) => {
        if (req.path.startsWith('/api/')) {
          res.status(status).json({ error: message });
        } else {
          res.status(status).type('text/plain').send(message);
        }
      };

      const origin = req.headers.origin;
      if (origin) {
        let originHost: string | undefined;
        try {
          originHost = new URL(origin).host;
        } catch {
          // handled below
        }
        // Admin mode compares with req.host, which honours X-Forwarded-Host
        // when trust proxy is set, and also accepts IMAP_MCP_ALLOWED_ORIGINS.
        const sameOrigin = originHost !== undefined && originHost === (this.admin ? req.host : req.headers.host);
        const listed = this.admin?.allowedOrigins?.some(allowed => originOf(allowed) === originOf(origin)) ?? false;
        if (!sameOrigin && !listed) {
          deny(403, 'Forbidden: cross-origin requests are not allowed.');
          return;
        }
      }

      const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
      if (queryToken !== undefined) {
        if (!this.tokenMatches(queryToken)) {
          deny(401, 'Unauthorized: invalid access token.');
          return;
        }
        const secure = req.secure ? '; Secure' : '';
        res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=${encodeURIComponent(queryToken)}; HttpOnly; SameSite=Strict; Path=/${secure}`);
        // Drop the token from the address bar and browser history.
        const url = new URL(req.originalUrl, 'http://wizard.invalid');
        url.searchParams.delete('token');
        // Collapse leading slashes so the target can never become a
        // protocol-relative URL ("//evil.example/").
        res.redirect(302, '/' + url.pathname.replace(/^\/+/, '') + url.search);
        return;
      }

      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const cookie = readCookie(req.headers.cookie, TOKEN_COOKIE);
      if ((bearer && this.tokenMatches(bearer)) || (cookie && this.tokenMatches(cookie))) {
        next();
        return;
      }

      deny(401, this.admin
        ? `Unauthorized: open this page with ?token=<admin token> (stored in ${adminTokenFile()} unless IMAP_MCP_WIZARD_TOKEN is set), or send it as "Authorization: Bearer".`
        : 'Unauthorized: open the wizard with the URL (including ?token=…) printed when imap-setup started.');
    };
  }

  // The bundled entrypoint may live at dist/web/server.js (npm run web) or be
  // inlined into dist/setup.js, so __dirname differs. Probe the likely
  // locations and fall back to the current working directory.
  private resolvePublicDir(): string {
    const candidates = [
      path.join(__dirname, '../../public'),
      path.join(__dirname, '../public'),
      path.join(process.cwd(), 'public'),
    ];
    const found = candidates.find(dir => fs.existsSync(path.join(dir, 'index.html')));
    return found ?? candidates[0];
  }

  private setupRoutes(): void {
    // Get all providers
    this.app.get('/api/providers', (req, res) => {
      res.json(emailProviders);
    });

    // Get all accounts
    this.app.get('/api/accounts', (req, res) => {
      try {
        const accounts = this.accountManager.getAllAccounts();
        // Never send credentials to the client — see stripAccountSecrets.
        res.json(accounts.map(stripAccountSecrets));
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch accounts' });
      }
    });

    // Add new account
    this.app.post('/api/accounts', async (req, res) => {
      try {
        const {
          name, email, password, host, port, tls, smtp, imapUsername, sentFolder, defaultBcc,
          imapUsernameFromEnv, imapPasswordFromEnv,
          smtpUsernameFromEnv, smtpPasswordFromEnv,
        } = req.body;

        // Auto-detect provider if not specified
        let imapHost = host;
        let imapPort = port;
        let useTls = tls;

        if (!host && email) {
          const provider = getProviderByEmail(email);
          if (provider) {
            imapHost = provider.imapHost;
            imapPort = provider.imapPort;
            useTls = provider.imapSecurity !== 'STARTTLS';
          }
        }

        // Credentials flagged as env-managed are stored as empty placeholders;
        // the corresponding IMAP_MCP_ACCOUNT_* env var supplies them at runtime.
        const account = await this.accountManager.addAccount({
          name: name || email,
          host: imapHost,
          port: imapPort || 993,
          user: imapUsernameFromEnv ? '' : (imapUsername || email),
          password: imapPasswordFromEnv ? '' : password,
          tls: useTls !== false,
          ...(imapUsername || imapUsernameFromEnv ? { email } : {}),
          smtp: smtp
            ? {
                ...smtp,
                ...(smtpUsernameFromEnv ? { user: '' } : {}),
                ...(smtpPasswordFromEnv ? { password: '' } : {}),
              }
            : undefined,
          ...(typeof sentFolder === 'string' && sentFolder ? { sentFolder } : {}),
          ...(defaultBcc !== undefined && defaultBcc !== '' && !(Array.isArray(defaultBcc) && defaultBcc.length === 0)
            ? { defaultBcc }
            : {}),
        });

        await this.accountChanged('account_created', account.id, req);
        // addAccount returns the plaintext password back; never echo it.
        res.json({ success: true, account: stripAccountSecrets(account) });
      } catch (error) {
        res.status(400).json({ 
          success: false, 
          error: error instanceof Error ? error.message : 'Failed to add account' 
        });
      }
    });

    // Test connection
    this.app.post('/api/test-connection', async (req, res) => {
      try {
        const { email, password, host, port, tls, imapUsername } = req.body;

        // Create temporary account for testing
        const testAccount: ImapAccount = {
          id: 'test-' + Date.now(),
          name: 'Test',
          host: host || 'imap.gmail.com',
          port: port || 993,
          user: imapUsername || email,
          password,
          tls: tls !== false,
        };
        
        // Try to connect
        await this.imapService.connect(testAccount);
        
        // Get folder list to verify connection works
        const folders = await this.imapService.listFolders(testAccount.id);
        
        // Disconnect
        await this.imapService.disconnect(testAccount.id);
        
        res.json({ 
          success: true, 
          folders: folders.map(f => f.name) 
        });
      } catch (error) {
        res.status(400).json({ 
          success: false, 
          error: error instanceof Error ? error.message : 'Connection test failed' 
        });
      }
    });

    // Remove account
    this.app.delete('/api/accounts/:id', async (req, res) => {
      try {
        await this.accountManager.removeAccount(req.params.id);
        await this.accountChanged('account_removed', req.params.id, req);
        res.json({ success: true });
      } catch (error) {
        res.status(400).json({ 
          success: false, 
          error: error instanceof Error ? error.message : 'Failed to remove account' 
        });
      }
    });

    // Update account
    this.app.put('/api/accounts/:id', async (req, res) => {
      try {
        const {
          name, email, password, host, port, tls, smtp, saveToSent, imapUsername, sentFolder, defaultBcc,
          imapUsernameFromEnv, imapPasswordFromEnv,
          smtpUsernameFromEnv, smtpPasswordFromEnv,
        } = req.body;

        const updates: any = {};
        if (name !== undefined) updates.name = name;
        // Env-managed username → store an empty placeholder for it.
        if (imapUsernameFromEnv) {
          updates.user = '';
          if (email !== undefined) updates.email = email;
        } else if (imapUsername) {
          updates.user = imapUsername;
          if (email !== undefined) updates.email = email;
        } else if (email !== undefined) {
          updates.user = email;
          updates.email = undefined;
        }
        // Env-managed password → empty placeholder; otherwise only update when sent.
        if (imapPasswordFromEnv) {
          updates.password = '';
        } else if (password !== undefined) {
          updates.password = password;
        }
        if (host !== undefined) updates.host = host;
        if (port !== undefined) updates.port = port;
        if (tls !== undefined) updates.tls = tls;
        if (smtp !== undefined) {
          updates.smtp = {
            ...smtp,
            ...(smtpUsernameFromEnv ? { user: '' } : {}),
            ...(smtpPasswordFromEnv ? { password: '' } : {}),
          };
        }
        if (saveToSent !== undefined) updates.saveToSent = saveToSent;
        // Empty string clears the override (falls back to auto-detection).
        if (typeof sentFolder === 'string') updates.sentFolder = sentFolder === '' ? undefined : sentFolder;
        if (defaultBcc !== undefined) {
          if (defaultBcc === '' || (Array.isArray(defaultBcc) && defaultBcc.length === 0)) {
            updates.defaultBcc = undefined;
          } else {
            updates.defaultBcc = defaultBcc;
          }
        }

        // updateAccount returns a DECRYPTED account (plaintext IMAP + SMTP
        // passwords). A no-op update (e.g. a rename with no password supplied)
        // would otherwise hand every stored secret back over the wire — strip.
        const account = await this.accountManager.updateAccount(req.params.id, updates);
        await this.accountChanged('account_updated', req.params.id, req);
        res.json({ success: true, account: stripAccountSecrets(account) });
      } catch (error) {
        res.status(400).json({ 
          success: false, 
          error: error instanceof Error ? error.message : 'Failed to update account' 
        });
      }
    });

    // Get single account
    this.app.get('/api/accounts/:id', async (req, res) => {
      try {
        const account = this.accountManager.getAccount(req.params.id);
        if (!account) {
          res.status(404).json({ success: false, error: 'Account not found' });
        } else {
          // Don't send passwords to client — see stripAccountSecrets.
          res.json({ success: true, account: stripAccountSecrets(account) });
        }
      } catch (error) {
        res.status(400).json({ 
          success: false, 
          error: error instanceof Error ? error.message : 'Failed to get account' 
        });
      }
    });

    // Test existing account connection (without re-entering password)
    this.app.post('/api/accounts/:id/test', async (req, res) => {
      try {
        const account = this.accountManager.getAccount(req.params.id);
        if (!account) {
          res.status(404).json({ success: false, error: 'Account not found' });
          return;
        }

        const result = await this.imapService.testConnection(account);

        res.json({
          success: result.success,
          accountId: account.id,
          accountName: account.name,
          host: account.host,
          folders: result.folders,
          messageCount: result.messageCount,
          error: result.error,
        });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Test failed',
        });
      }
    });

    // Health check
    this.app.get('/api/health', (req, res) => {
      res.json({ status: 'ok', version: PACKAGE_VERSION });
    });
  }

  // Admin mode shares its services with the MCP endpoint: drop the cached
  // connections of a changed or removed account so its old credentials stop
  // being used, and record the change.
  private async accountChanged(event: AuditEvent, accountId: string, req: express.Request): Promise<void> {
    if (!this.admin) return;
    if (event !== 'account_created') {
      await this.imapService.disconnect(accountId);
      this.smtpService?.disconnect(accountId);
    }
    this.admin.auditLog.record({ event, ip: req.ip, args: { accountId } });
  }

  // Agent tokens and the audit trail. Grants are checked against the catalog,
  // so unknown tools and the admin group can never end up on a token.
  private setupAdminRoutes({ tokenStore, auditLog, catalog, accessEnabled }: AdminDeps): void {
    const grantable = new Set(catalog.tools.map(tool => tool.name));

    const parseTokenBody = (body: any, creating: boolean): { name?: string; tools?: string[] } | { error: string } => {
      const parsed: { name?: string; tools?: string[] } = {};
      if (creating || body?.name !== undefined) {
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 100) {
          return { error: 'name must be a non-empty string of at most 100 characters.' };
        }
        parsed.name = name;
      }
      if (creating || body?.tools !== undefined || body?.preset !== undefined) {
        if (body?.tools !== undefined && !(Array.isArray(body.tools) && body.tools.every((tool: unknown) => typeof tool === 'string'))) {
          return { error: 'tools must be an array of tool names.' };
        }
        if (body?.preset !== undefined && !(typeof body.preset === 'string' && Object.hasOwn(catalog.presets, body.preset))) {
          return { error: `Unknown preset. Known presets: ${Object.keys(catalog.presets).join(', ')}.` };
        }
        const tools: string[] = [...new Set<string>([...(body?.preset ? catalog.presets[body.preset] : []), ...(body?.tools ?? [])])];
        const refused = tools.filter(tool => !grantable.has(tool));
        if (refused.length > 0) {
          return { error: `Not grantable to an agent token: ${refused.join(', ')}.` };
        }
        if (tools.length === 0) {
          return { error: 'A token needs at least one tool: send tools and/or preset.' };
        }
        parsed.tools = tools;
      }
      if (!creating && parsed.name === undefined && parsed.tools === undefined) {
        return { error: 'Nothing to update: send name, tools or preset.' };
      }
      return parsed;
    };

    this.app.get('/api/tools/catalog', (req, res) => {
      res.json(accessEnabled ? { ...catalog, accessEnabled } : catalog);
    });

    this.app.get('/api/tokens', (req, res) => {
      res.json(tokenStore.list());
    });

    this.app.post('/api/tokens', async (req, res) => {
      const parsed = parseTokenBody(req.body, true);
      if ('error' in parsed) {
        res.status(400).json({ success: false, error: parsed.error });
        return;
      }
      const email = req.body?.accessEmail;
      if (email !== undefined) {
        if (!accessEnabled || typeof email !== 'string' || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          res.status(400).json({ success: false, error: 'An OAuth grant requires configured Access and a valid login email.' });
          return;
        }
        if (tokenStore.forAccessEmail(email.toLowerCase())) {
          res.status(409).json({ success: false, error: 'This login already has an active grant.' });
          return;
        }
      }
      try {
        if (email !== undefined) {
          const info = await tokenStore.grantAccess(parsed.name!, email, parsed.tools!);
          auditLog.record({ event: 'token_created', tokenId: info.id, tokenName: info.name, ip: req.ip, args: { accessEmail: info.accessEmail, tools: info.tools } });
          res.status(201).json({ success: true, token: info });
          return;
        }
        const { info, token } = await tokenStore.create(parsed.name!, parsed.tools!);
        auditLog.record({ event: 'token_created', tokenId: info.id, tokenName: info.name, ip: req.ip, args: { tools: info.tools } });
        // The only response that ever carries the full token.
        res.status(201).json({ success: true, token: info, secret: token });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to create token' });
      }
    });

    this.app.patch('/api/tokens/:id', async (req, res) => {
      if (req.body?.accessEmail !== undefined) {
        res.status(400).json({ success: false, error: 'To change the login email, revoke the grant and create a new one.' });
        return;
      }
      if (!tokenStore.get(req.params.id)) {
        res.status(404).json({ success: false, error: 'Token not found' });
        return;
      }
      const parsed = parseTokenBody(req.body, false);
      if ('error' in parsed) {
        res.status(400).json({ success: false, error: parsed.error });
        return;
      }
      try {
        const info = await tokenStore.update(req.params.id, parsed);
        auditLog.record({ event: 'token_updated', tokenId: info.id, tokenName: info.name, ip: req.ip, args: { ...parsed } });
        res.json({ success: true, token: info });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to update token' });
      }
    });

    this.app.post('/api/tokens/:id/revoke', async (req, res) => {
      if (!tokenStore.get(req.params.id)) {
        res.status(404).json({ success: false, error: 'Token not found' });
        return;
      }
      try {
        const info = await tokenStore.revoke(req.params.id);
        auditLog.record({ event: 'token_revoked', tokenId: info.id, tokenName: info.name, ip: req.ip });
        res.json({ success: true, token: info });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to revoke token' });
      }
    });

    this.app.get('/api/audit', (req, res) => {
      const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
      res.json(auditLog.query({
        limit: Number(req.query.limit) || undefined,
        before: text(req.query.before),
        tokenId: text(req.query.tokenId),
        tool: text(req.query.tool),
      }));
    });
  }

  async start(autoOpen: boolean = true): Promise<void> {
    return new Promise((resolve) => {
      const server = this.app.listen(this.port, this.bindHost, () => {
        // The URL may contain the generated one-time wizard token. Printing it is
        // deliberate (like Jupyter): it is how the user gets into the wizard from
        // another machine, it is not a mailbox credential, and it dies with the
        // process.
        console.log(`🌐 Web UI server running at ${this.getAccessUrl()}`);
        if (this.isRemote()) {
          console.warn(
            `⚠️  The setup wizard is reachable from the network (bind ${this.bindHost}). ` +
            'Access requires the token, but the connection is plain HTTP — use this only on ' +
            'trusted networks, or prefer an SSH tunnel to a loopback-bound wizard.',
          );
        }

        if (autoOpen) {
          // Open browser after a short delay
          setTimeout(() => {
            open(this.getAccessUrl(true));
          }, 1000);
        }
        
        resolve();
      });

      // Handle graceful shutdown
      process.on('SIGINT', () => {
        console.log('\nShutting down web server...');
        server.close(() => {
          process.exit(0);
        });
      });
    });
  }
}