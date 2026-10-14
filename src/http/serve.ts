import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Command } from 'commander';
import { createServices, type Services } from '../core.js';
import { collectToolDefinitions } from '../tools/registry.js';
import { toolCatalog } from '../tools/policy.js';
import { TokenStore } from '../services/token-store.js';
import { AuditLog } from '../services/audit-log.js';
import { WebUIServer, adminTokenFile } from '../web/server.js';
import { createMcpRouter } from './mcp.js';
import { httpToolDefinitions, maxUploadSize } from './overrides.js';
import { hostGuard, parseList } from './guards.js';

export interface ServeOptions {
  host: string;
  port: number;
}

/** `serve [--host <host>] [--port <port>]`, falling back to IMAP_MCP_HTTP_HOST / IMAP_MCP_HTTP_PORT. */
export function parseServeOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): ServeOptions {
  const program = new Command('imap-mcp-server serve')
    .description('Serve the tools over Streamable HTTP at /mcp, with the admin UI on the same port. Plain HTTP only: put TLS in front of it if it leaves the machine.')
    .option('--host <host>', 'Address to listen on (IMAP_MCP_HTTP_HOST)', env.IMAP_MCP_HTTP_HOST?.trim() || '127.0.0.1')
    .option('--port <port>', 'Port to listen on (IMAP_MCP_HTTP_PORT)', env.IMAP_MCP_HTTP_PORT?.trim() || '8765')
    .parse(argv, { from: 'user' });

  const { host, port } = program.opts<{ host: string; port: string }>();
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  return { host, port: portNumber };
}

/**
 * IMAP_MCP_TRUST_PROXY as Express's `trust proxy` setting: true/false, a hop
 * count, or addresses/subnets/presets such as "loopback" (default: false).
 */
export function trustProxySetting(value: string | undefined): boolean | number | string {
  const setting = value?.trim();
  if (!setting || setting === 'false') return false;
  if (setting === 'true') return true;
  if (/^\d+$/.test(setting)) return Number(setting);
  return setting;
}

/**
 * The serve application: the Host guard for everything, POST /mcp for agent
 * tokens, and the wizard in admin mode (admin token) for every other path.
 */
export function createServeApp(
  services: Services,
  options: { host: string; port: number; tokenStore: TokenStore; auditLog: AuditLog }
): express.Express {
  const { tokenStore, auditLog } = options;
  const definitions = httpToolDefinitions(collectToolDefinitions(services), services);
  const allowedOrigins = parseList(process.env.IMAP_MCP_ALLOWED_ORIGINS);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxySetting(process.env.IMAP_MCP_TRUST_PROXY));
  app.use(hostGuard(options.host, parseList(process.env.IMAP_MCP_ALLOWED_HOSTS)));
  app.use(createMcpRouter({
    definitions,
    smtpService: services.smtpService,
    tokenStore,
    auditLog,
    allowedOrigins,
    // Base64 attachments up to the upload limit, plus room for the JSON-RPC envelope.
    maxBodyBytes: Math.ceil((maxUploadSize() * 4) / 3) + 1024 * 1024,
  }));

  const admin = new WebUIServer(options.port, {
    accountManager: services.accountManager,
    imapService: services.imapService,
    smtpService: services.smtpService,
    bindHost: options.host,
    admin: { tokenStore, auditLog, catalog: toolCatalog(definitions), allowedOrigins },
  });
  app.use(admin.getApp());
  return app;
}

/** `imap-mcp-server serve`: a long-running HTTP server on host:port. */
export async function startServe(argv: string[]): Promise<void> {
  const options = parseServeOptions(argv);
  const services = createServices();
  const tokenStore = new TokenStore();
  const auditLog = new AuditLog();
  const app = createServeApp(services, { ...options, tokenStore, auditLog });

  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(options.port, options.host, (error?: Error) => (error ? reject(error) : resolve(listening)));
  });

  const { port } = server.address() as AddressInfo;
  const base = `http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${port}`;
  const adminToken = process.env.IMAP_MCP_WIZARD_TOKEN?.trim() ? 'IMAP_MCP_WIZARD_TOKEN' : adminTokenFile();
  console.log(`IMAP MCP Server listening on ${base}`);
  console.log(`  MCP endpoint: ${base}/mcp (Authorization: Bearer <agent token>)`);
  console.log(`  Admin UI/API: ${base}/ (admin token: ${adminToken})`);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down`);
    server.close();
    Promise.allSettled([tokenStore.flush(), services.imapService.disconnectAll()]).finally(() => {
      services.smtpService.disconnectAll();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
