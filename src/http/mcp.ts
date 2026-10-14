import express, { type ErrorRequestHandler, type Request, type Router } from 'express';
import { AsyncLocalStorage } from 'async_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { applyToolDefinitions, type ToolDefinition } from '../tools/registry.js';
import { summarizeArgs, type AuditLog, type Recipients } from '../services/audit-log.js';
import type { TokenStore } from '../services/token-store.js';
import type { SmtpService } from '../services/smtp-service.js';
import { PACKAGE_VERSION } from '../utils/version.js';
import { DENIED_META_KEY } from '../utils/denied.js';
import { bearerAuth, jsonRpcError, originAllowlist } from './guards.js';

/**
 * Thrown by a handler to refuse a call by policy: audited as `denied`, not
 * `error`, and answered with an error result marked by DENIED_META_KEY.
 */
export class ToolDeniedError extends Error {}

const deniedResult = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true,
  _meta: { [DENIED_META_KEY]: true },
});

export interface McpEndpointOptions {
  /** HTTP tool definitions; each request registers the token's subset. */
  definitions: readonly ToolDefinition[];
  smtpService: SmtpService;
  tokenStore: TokenStore;
  auditLog: AuditLog;
  allowedOrigins: string[];
  maxBodyBytes: number;
}

interface SendContext {
  recipients?: Recipients;
}

/**
 * Note the SMTP envelope of mail sent during a tool call, so its audit entry
 * holds the recipients actually used: a reply's are derived from the original
 * and the account's defaultBcc is merged in by the tool. Wraps sendEmail on
 * the shared instance once, at startup.
 */
function captureRecipients(smtpService: SmtpService): AsyncLocalStorage<SendContext> {
  const storage = new AsyncLocalStorage<SendContext>();
  const send = smtpService.sendEmail.bind(smtpService);
  smtpService.sendEmail = (accountId, account, email) => {
    const context = storage.getStore();
    if (context) {
      context.recipients = { to: email.to, cc: email.cc, bcc: email.bcc };
    }
    return send(accountId, account, email);
  };
  return storage;
}

// body-parser errors from express.json() on /mcp.
const bodyErrors: ErrorRequestHandler = (err, _req, res, next) => {
  if (err?.type === 'entity.too.large') {
    res.status(413).json(jsonRpcError(-32000, 'Request body too large (limit follows IMAP_MAX_UPLOAD_SIZE).'));
  } else if (err?.type === 'entity.parse.failed') {
    res.status(400).json(jsonRpcError(-32700, 'Parse error: the body is not valid JSON.'));
  } else {
    next(err);
  }
};

/**
 * POST /mcp — stateless Streamable HTTP. Each request gets its own McpServer
 * with only the tools the request's agent token may use, so a token change or
 * revocation applies to the very next request. Other methods answer 405.
 */
export function createMcpRouter(options: McpEndpointOptions): Router {
  const { definitions, tokenStore, auditLog } = options;
  const sending = captureRecipients(options.smtpService);
  const router = express.Router();

  router.post(
    '/mcp',
    originAllowlist(options.allowedOrigins),
    bearerAuth(tokenStore, auditLog),
    express.json({ limit: options.maxBodyBytes }),
    async (req, res) => {
      const auth = (req as Request & { auth: AuthInfo }).auth;
      const allowed = new Set(auth.scopes);
      const audit = (tool: string, entry: { outcome: 'ok' | 'error' | 'denied'; durationMs?: number; args?: Record<string, unknown> }) =>
        auditLog.record({
          event: 'tool_call',
          tokenId: auth.clientId,
          tokenName: auth.extra?.tokenName as string | undefined,
          tool,
          ip: req.ip,
          ...entry,
        });

      // Calls to tools the token lacks never reach a handler (the server does
      // not have them and answers "not found"), so record them here.
      for (const message of [req.body].flat()) {
        if (message?.method === 'tools/call' && !allowed.has(message.params?.name)) {
          audit(String(message.params?.name), { outcome: 'denied' });
        }
      }

      const server = new McpServer({ name: 'imap-mcp-server', version: PACKAGE_VERSION });
      applyToolDefinitions(server, definitions, allowed, definition => async (args: any, extra: any) => {
        // Defence in depth: only allowed tools are registered, check per call too.
        if (!extra?.authInfo?.scopes?.includes(definition.name)) {
          audit(definition.name, { outcome: 'denied' });
          return deniedResult(`Tool ${definition.name} is not allowed for this token`);
        }
        const started = Date.now();
        const context: SendContext = {};
        const finish = (outcome: 'ok' | 'error' | 'denied') =>
          audit(definition.name, {
            outcome,
            durationMs: Date.now() - started,
            args: summarizeArgs(definition.name, args, context.recipients),
          });
        try {
          const result = await sending.run(context, () => definition.handler(args, extra));
          finish(result?.isError ? 'error' : 'ok');
          return result;
        } catch (error) {
          if (error instanceof ToolDeniedError) {
            finish('denied');
            return deniedResult(error.message);
          }
          finish('error');
          throw error;
        }
      });

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error('[imap-mcp] MCP request failed:', error instanceof Error ? error.message : error);
        if (!res.headersSent) {
          res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
        }
      }
    }
  );

  // Stateless: no SSE stream to GET and no session to DELETE.
  router.all('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').json(jsonRpcError(-32000, 'Method not allowed: /mcp is stateless and accepts POST only.'));
  });

  router.use('/mcp', bodyErrors);
  return router;
}
