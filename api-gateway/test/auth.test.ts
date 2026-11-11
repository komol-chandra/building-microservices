import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import config from '../src/config.json';
import * as auth from '../src/auth';

// Two key pairs: "ours" is in the key set the gateway trusts, "theirs" is not.
let ours: KeyLike;
let theirs: KeyLike;
beforeAll(async () => {
  const a = await generateKeyPair('RS256');
  const b = await generateKeyPair('RS256');
  ours = a.privateKey;
  theirs = b.privateKey;
  auth.setKeySource(createLocalJWKSet({ keys: [{ ...(await exportJWK(a.publicKey)), kid: 'k1', alg: 'RS256' }] }));
});

const claims = { email: 'user@shop.test', name: 'Komol কমল', role: 'user' };

async function token(
  opts: { key?: KeyLike; kid?: string; payload?: object; iss?: string; aud?: string; exp?: string | number } = {},
) {
  return new SignJWT({ ...claims, ...opts.payload })
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'k1' })
    .setSubject('u1')
    .setIssuer(opts.iss ?? 'auth-service')
    .setAudience(opts.aud ?? 'shop')
    .setExpirationTime(opts.exp ?? '1h')
    .sign(opts.key ?? ours);
}
const bearer = async (opts?: Parameters<typeof token>[0]) => `Bearer ${await token(opts)}`;

/** Minimal Express req/res doubles. */
async function run(handler: any, headers: Record<string, string | undefined> = {}) {
  const req = { headers: { ...headers } } as any;
  const res = { statusCode: 200, body: undefined as any, status: vi.fn(), json: vi.fn() } as any;
  res.status.mockImplementation((c: number) => ((res.statusCode = c), res));
  res.json.mockImplementation((b: unknown) => ((res.body = b), res));
  const next = vi.fn();
  await handler(req, res, next);
  return { req, res, next };
}

describe('verifyToken', () => {
  it('accepts a valid RS256 token from our issuer', async () => {
    expect(await auth.verifyToken(await bearer())).toEqual({ ok: true, claims: { sub: 'u1', ...claims } });
  });

  it('rejects a token signed by a key that is not in the JWKS', async () => {
    expect(await auth.verifyToken(await bearer({ key: theirs }))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects our key but the wrong issuer or audience', async () => {
    expect((await auth.verifyToken(await bearer({ iss: 'evil' }))).ok).toBe(false);
    expect((await auth.verifyToken(await bearer({ aud: 'another-app' }))).ok).toBe(false);
  });

  it('rejects an expired token', async () => {
    expect((await auth.verifyToken(await bearer({ exp: Math.floor(Date.now() / 1000) - 10 }))).ok).toBe(false);
  });

  it('rejects an unknown role', async () => {
    expect((await auth.verifyToken(await bearer({ payload: { role: 'superuser' } }))).ok).toBe(false);
  });

  it('rejects the "alg: none" trick', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'u1', ...claims, role: 'admin' })).toString('base64url');
    expect((await auth.verifyToken(`Bearer ${header}.${payload}.`)).ok).toBe(false);
  });

  it('rejects a missing or non-Bearer header', async () => {
    expect((await auth.verifyToken(undefined)).ok).toBe(false);
    expect((await auth.verifyToken('Basic abc')).ok).toBe(false);
  });
});

describe('authorize', () => {
  it('lets public routes through without a token', async () => {
    expect((await run(auth.authorize([]))).next).toHaveBeenCalled();
  });

  it('401 without a token', async () => {
    const { res, next } = await run(auth.authorize(['user']));
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('403 for the wrong role', async () => {
    const { res, next } = await run(auth.authorize(['admin']), { authorization: await bearer() });
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('sets x-user-* from the verified token (name URL-encoded: headers are ASCII only)', async () => {
    const { req, next } = await run(auth.authorize(['user', 'admin']), { authorization: await bearer() });
    expect(next).toHaveBeenCalled();
    expect(req.headers).toMatchObject({ 'x-user-id': 'u1', 'x-user-email': 'user@shop.test', 'x-user-role': 'user' });
    expect(decodeURIComponent(req.headers['x-user-name'])).toBe('Komol কমল');
    expect(req.headers['x-user-name']).toMatch(/^[\x20-\x7e]*$/);
  });

  it('503 (not 401) when the signing keys cannot be fetched', async () => {
    auth.setKeySource(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });
    try {
      const { res, next } = await run(auth.authorize(['user']), { authorization: await bearer() });
      expect(res.statusCode).toBe(503);
      expect(next).not.toHaveBeenCalled();
    } finally {
      const pub = await generateKeyPair('RS256'); // restore a key set (other tests don't depend on it after this)
      auth.setKeySource(createLocalJWKSet({ keys: [{ ...(await exportJWK(pub.publicKey)), kid: 'x' }] }));
    }
  });
});

describe('route table (config.json)', () => {
  it('every route points to a known service', () => {
    for (const r of config.routes) expect(Object.keys(config.services)).toContain(r.service);
  });

  it('keeps internal endpoints internal: POST /inventories is not routed', () => {
    expect(config.routes.some((r) => r.method === 'POST' && r.path === '/inventories')).toBe(false);
  });

  it('all writes require a role, except login and register', () => {
    const publicWrites = config.routes.filter((r) => r.method !== 'GET' && r.roles.length === 0).map((r) => r.path);
    expect(publicWrites.sort()).toEqual(['/auth/login', '/auth/register']);
  });

  it('user admin endpoints are admin-only', () => {
    for (const r of config.routes.filter((r) => r.path.startsWith('/users'))) expect(r.roles).toEqual(['admin']);
  });
});
