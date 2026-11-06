import { createRemoteJWKSet, jwtVerify } from 'jose';

export type AccessIdentity = { kind: 'user'; email: string } | { kind: 'service'; clientId: string };
export type AccessVerifier = (assertion: string) => Promise<AccessIdentity | undefined>;

/** Resolve rotating keys only from the configured team's HTTPS endpoint. */
export function configuredAccess(env: NodeJS.ProcessEnv): AccessVerifier | undefined {
  const domain = env.IMAP_MCP_ACCESS_TEAM_DOMAIN?.trim().toLowerCase();
  const audience = env.IMAP_MCP_ACCESS_AUD?.trim();
  if (!domain && !audience) return;
  if (!domain || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain) || !audience) {
    throw new Error('Cloudflare mode requires IMAP_MCP_ACCESS_TEAM_DOMAIN (<team>.cloudflareaccess.com) and IMAP_MCP_ACCESS_AUD.');
  }
  const issuer = `https://${domain}`;
  const getKey = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
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
