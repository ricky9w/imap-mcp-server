import { open } from 'node:fs/promises';
import { createLocalJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export type AccessIdentity = { kind: 'user'; email: string } | { kind: 'service'; clientId: string };
export type AccessVerifier = (assertion: string) => Promise<AccessIdentity | undefined>;

/** Only trust application assertions for this team's path-specific /mcp application. */
export function createAccessVerifier(issuer: string, audience: string, getKey: JWTVerifyGetKey): AccessVerifier {
  return async assertion => {
    try {
      const { payload } = await jwtVerify(assertion, getKey, {
        issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'sub'],
      });
      if (payload.type !== 'app') return;
      if (typeof payload.sub === 'string' && payload.sub && typeof payload.email === 'string' && payload.email.trim()) {
        return { kind: 'user', email: payload.email.trim().toLowerCase() };
      }
      if (payload.sub === '' && typeof payload.common_name === 'string' && payload.common_name) {
        return { kind: 'service', clientId: payload.common_name };
      }
    } catch {
      // Unknown key, signature or claims: fail closed without logging the assertion.
      return undefined;
    }
  };
}

/** Deployment refreshes this public JWKS atomically. Reload on rotation and reject stale keys. */
function keysFromFile(file: string): JWTVerifyGetKey {
  let cached: { json: string; resolve: ReturnType<typeof createLocalJWKSet> } | undefined;
  return async (header, token) => {
    const handle = await open(file, 'r');
    try {
      const { mtimeMs } = await handle.stat();
      if (Date.now() - mtimeMs > 24 * 60 * 60 * 1000) throw new Error('Access signing keys need refreshing.');
      const json = await handle.readFile('utf8');
      if (cached?.json !== json) cached = { json, resolve: createLocalJWKSet(JSON.parse(json)) };
      return cached.resolve(header, token);
    } finally {
      await handle.close();
    }
  };
}

export function configuredAccess(env: NodeJS.ProcessEnv): AccessVerifier | undefined {
  const domain = env.IMAP_MCP_ACCESS_TEAM_DOMAIN?.trim().toLowerCase();
  const audience = env.IMAP_MCP_ACCESS_AUD?.trim();
  const file = env.IMAP_MCP_ACCESS_JWKS_FILE?.trim();
  if (!domain && !audience && !file) return;
  if (!domain || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain) || !audience || !file) {
    throw new Error('Cloudflare mode requires IMAP_MCP_ACCESS_TEAM_DOMAIN (<team>.cloudflareaccess.com), IMAP_MCP_ACCESS_AUD and IMAP_MCP_ACCESS_JWKS_FILE.');
  }
  return createAccessVerifier(`https://${domain}`, audience, keysFromFile(file));
}
