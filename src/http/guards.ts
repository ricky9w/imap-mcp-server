import type { Request, RequestHandler } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { TokenStore } from '../services/token-store.js';
import type { AuditLog } from '../services/audit-log.js';
import { effectiveTools } from '../tools/policy.js';

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const isLoopbackHost = (host: string): boolean => LOOPBACK_NAMES.has(host.toLowerCase());

/** A comma-separated environment list, trimmed, empty entries dropped. */
export const parseList = (value: string | undefined): string[] =>
  (value ?? '').split(',').map(entry => entry.trim()).filter(Boolean);

/** `scheme://host[:port]` of an origin string, or undefined when it is not a URL. */
export function normalizeOrigin(origin: string): string | undefined {
  try {
    return new URL(origin).origin.toLowerCase();
  } catch {
    return undefined;
  }
}

export const jsonRpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

/**
 * DNS-rebinding guard for every request. With IMAP_MCP_ALLOWED_HOSTS the host
 * must be on the list; without it a loopback-bound server only answers to
 * loopback names, and a server bound elsewhere does not check. req.hostname
 * honours X-Forwarded-Host when trust proxy is configured.
 */
export function hostGuard(bindHost: string, allowedHosts: string[]): RequestHandler {
  const allowed = new Set(allowedHosts.map(host => host.toLowerCase()));
  const loopbackOnly = allowed.size === 0 && isLoopbackHost(bindHost);
  return (req, res, next) => {
    const host = (req.hostname ?? '').toLowerCase();
    if ((allowed.size > 0 && !allowed.has(host)) || (loopbackOnly && !isLoopbackHost(host))) {
      res.status(403).json({ error: 'Forbidden: unexpected Host header. Set IMAP_MCP_ALLOWED_HOSTS when serving behind a proxy.' });
      return;
    }
    next();
  };
}

/**
 * /mcp is for agents, not browsers: a request that carries an Origin header
 * is refused unless that origin is listed in IMAP_MCP_ALLOWED_ORIGINS.
 */
export function originAllowlist(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins.map(normalizeOrigin).filter(Boolean));
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(normalizeOrigin(origin))) {
      res.status(403).json(jsonRpcError(-32000, 'Forbidden: cross-origin requests are not allowed.'));
      return;
    }
    next();
  };
}

/**
 * Agent-token authentication. A valid, unrevoked `imcp_…` token sets
 * req.auth, which the SDK hands to tool handlers as extra.authInfo; its scopes
 * are the token's effective tools. The admin token is not an agent token and
 * is rejected here like any other unknown value.
 */
export function bearerAuth(tokenStore: TokenStore, auditLog: AuditLog): RequestHandler {
  return (req, res, next) => {
    const presented = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const token = presented ? tokenStore.verify(presented) : undefined;
    if (!token) {
      const tokenId = TokenStore.idOf(presented);
      auditLog.record({ event: 'auth_failed', outcome: 'denied', ip: req.ip, ...(tokenId ? { tokenId } : {}) });
      res
        .status(401)
        .set('WWW-Authenticate', 'Bearer realm="imap-mcp"')
        .json(jsonRpcError(-32001, 'Unauthorized: send a valid agent token as "Authorization: Bearer imcp_…".'));
      return;
    }

    tokenStore.recordUse(token.id, req.ip);
    const auth: AuthInfo = {
      token: token.id,
      clientId: token.id,
      scopes: [...effectiveTools(token.tools)],
      extra: { tokenName: token.name },
    };
    (req as Request & { auth?: AuthInfo }).auth = auth;
    next();
  };
}
