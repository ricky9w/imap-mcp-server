import type { Request, RequestHandler } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { AccessVerifier } from './access.js';
import { TokenStore, type AgentTokenInfo } from '../services/token-store.js';
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
 * Resolve each request to a live grant, then pass its effective tools to the SDK.
 * Cloudflare manages the OAuth discovery and token exchange at the public edge.
 */
export function agentAuth(tokenStore: TokenStore, auditLog: AuditLog, verifyAccess?: AccessVerifier): RequestHandler {
  return async (req, res, next) => {
    const presented = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const assertion = req.get('Cf-Access-Jwt-Assertion');
    const identity = verifyAccess && assertion ? await verifyAccess(assertion) : undefined;
    // With Access enabled, a direct origin request cannot use a local token to skip Access.
    // A service assertion still needs the script's own token and its individual permissions.
    let token: AgentTokenInfo | undefined;
    if (identity?.kind === 'user') {
      token = tokenStore.forAccessEmail(identity.email);
      if (!token) {
        auditLog.record({ event: 'auth_failed', outcome: 'denied', ip: req.ip, args: { accessEmail: identity.email } });
        res.status(403).json(jsonRpcError(-32001, 'This Access login has no active mail tool grant.'));
        return;
      }
    } else if (!verifyAccess || identity?.kind === 'service') {
      token = tokenStore.verify(presented);
    }
    if (!token) {
      const tokenId = TokenStore.idOf(presented);
      auditLog.record({ event: 'auth_failed', outcome: 'denied', ip: req.ip, ...(tokenId ? { tokenId } : {}) });
      const message = verifyAccess && !identity
        ? 'Unauthorized: a valid Cloudflare Access assertion is required.'
        : 'Unauthorized: send a valid agent token as "Authorization: Bearer imcp_…".';
      res.status(401).set('WWW-Authenticate', 'Bearer realm="imap-mcp"').json(jsonRpcError(-32001, message));
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
