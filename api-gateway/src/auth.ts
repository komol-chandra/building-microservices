import type { RequestHandler } from 'express';
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

export type Role = 'user' | 'admin';

/** What the gateway needs from a verified token. `sub` (subject) = user id. */
export interface Claims {
  sub: string;
  email: string;
  name: string;
  role: Role;
}

/**
 * Phase 9: the gateway no longer signs tokens or knows any users.
 * auth-service signs with its PRIVATE key (RS256); the gateway verifies with
 * the PUBLIC keys from auth-service's JWKS endpoint. The gateway can check a
 * token but can never create one.
 *
 * createRemoteJWKSet caches the keys in memory:
 *   - known `kid`   → verified locally, NO call to auth-service (fast, and works while it is down)
 *   - unknown `kid` → refetch the JWKS once (key rotation), at most every 5s (cooldown).
 *     jose's default cooldown is 30s: found in testing that a token from a freshly rotated key
 *     then got 401 for up to 30s (→ the UI logs the user out). 5s is shorter than an
 *     auth-service restart, and caps "unknown kid" spam at one JWKS fetch per 5s.
 * cacheMaxAge = Infinity: never drop keys just because time passed. The trade-off:
 * a key removed from the JWKS stays trusted until the gateway restarts.
 */
const ISSUER = process.env.JWT_ISSUER ?? 'auth-service';
const AUDIENCE = process.env.JWT_AUDIENCE ?? 'shop';

let getKey: JWTVerifyGetKey | undefined;
function keys(): JWTVerifyGetKey {
  if (!getKey) {
    const url = process.env.AUTH_JWKS_URL;
    if (!url) throw new Error('AUTH_JWKS_URL is not set');
    getKey = createRemoteJWKSet(new URL(url), { cacheMaxAge: Infinity, cooldownDuration: 5000, timeoutDuration: 2000 });
  }
  return getKey;
}

/** Tests inject a local key set instead of fetching one over HTTP. */
export function setKeySource(k: JWTVerifyGetKey): void {
  getKey = k;
}

export type VerifyResult = { ok: true; claims: Claims } | { ok: false; reason: 'invalid' | 'unavailable' };

/**
 * invalid     → bad/expired/forged token, or signed by a key we don't know → 401
 * unavailable → we couldn't get the keys (auth-service down, never fetched yet) → 503.
 *               Not the client's fault, so not a 401 (the UI would log the user out).
 */
export async function verifyToken(header: string | undefined): Promise<VerifyResult> {
  if (!header?.startsWith('Bearer ')) return { ok: false, reason: 'invalid' };
  try {
    const { payload } = await jwtVerify(header.slice(7), keys(), {
      algorithms: ['RS256'], // pinned: blocks "alg: none" and HS256-with-the-public-key tricks
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const { sub, email, name, role } = payload as Partial<Claims>;
    if (!sub || !email || (role !== 'user' && role !== 'admin')) return { ok: false, reason: 'invalid' };
    return { ok: true, claims: { sub, email, name: name ?? '', role } };
  } catch (e) {
    const fetchProblem =
      e instanceof errors.JWKSTimeout ||
      !(e instanceof errors.JOSEError) || // network error (ECONNREFUSED, DNS...)
      (e as errors.JOSEError).code === 'ERR_JOSE_GENERIC'; // JWKS answered non-200
    return { ok: false, reason: fetchProblem ? 'unavailable' : 'invalid' };
  }
}

export const IDENTITY_HEADERS = ['x-user-id', 'x-user-email', 'x-user-name', 'x-user-role'] as const;

/**
 * Edge auth for one route.
 *   roles = []               → public
 *   roles = ['admin']        → must be logged in AND be admin
 * On success, the identity is passed to the service as trusted headers.
 */
export function authorize(roles: Role[]): RequestHandler {
  return async (req, res, next) => {
    if (roles.length === 0) return next();

    const result = await verifyToken(req.headers.authorization);
    if (!result.ok) {
      if (result.reason === 'unavailable') {
        console.error('[gateway] cannot load signing keys from auth-service');
        res.status(503).json({ error: 'ServiceUnavailable', message: 'Cannot verify tokens right now (auth-service unavailable)' });
      } else {
        res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid token' });
      }
      return;
    }
    const { claims } = result;
    if (!roles.includes(claims.role)) {
      res.status(403).json({ error: 'Forbidden', message: `Requires role: ${roles.join(' or ')}` });
      return;
    }
    req.headers['x-user-id'] = claims.sub;
    req.headers['x-user-email'] = claims.email;
    // Header values must be ASCII; names may not be ("Komol কমল"), so the name is URL-encoded.
    req.headers['x-user-name'] = encodeURIComponent(claims.name);
    req.headers['x-user-role'] = claims.role;
    next();
  };
}
