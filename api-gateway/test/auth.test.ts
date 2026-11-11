import { beforeAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import config from '../src/config.json';

// auth.ts reads JWT_SECRET when it is imported → set it first, then import dynamically.
const SECRET = 'test-secret';
process.env.JWT_SECRET = SECRET;
let auth: typeof import('../src/auth');
beforeAll(async () => {
  auth = await import('../src/auth');
});

const claims = { sub: 'u1', email: 'user@shop.test', name: 'U', role: 'user' as const };
const bearer = (payload: object, secret = SECRET, opts: jwt.SignOptions = {}) => `Bearer ${jwt.sign(payload, secret, opts)}`;

/** Minimal Express req/res doubles. */
function run(handler: any, headers: Record<string, string | undefined> = {}, body?: unknown) {
  const req = { headers: { ...headers }, body } as any;
  const res = { statusCode: 200, body: undefined as any, status: vi.fn(), json: vi.fn() } as any;
  res.status.mockImplementation((c: number) => ((res.statusCode = c), res));
  res.json.mockImplementation((b: unknown) => ((res.body = b), res));
  const next = vi.fn();
  handler(req, res, next);
  return { req, res, next };
}

describe('verifyToken', () => {
  it('accepts a valid HS256 token', () => {
    expect(auth.verifyToken(bearer(claims))).toMatchObject(claims);
  });

  it('rejects a token signed with another secret', () => {
    expect(auth.verifyToken(bearer(claims, 'other-secret'))).toBeNull();
  });

  it('rejects an expired token', () => {
    expect(auth.verifyToken(bearer({ ...claims, exp: Math.floor(Date.now() / 1000) - 10 }))).toBeNull();
  });

  it('rejects the "alg: none" trick', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ ...claims, role: 'admin' })).toString('base64url');
    expect(auth.verifyToken(`Bearer ${header}.${payload}.`)).toBeNull();
  });

  it('rejects a missing or non-Bearer header', () => {
    expect(auth.verifyToken(undefined)).toBeNull();
    expect(auth.verifyToken('Basic abc')).toBeNull();
  });
});

describe('authorize', () => {
  it('lets public routes through without a token', () => {
    expect(run(auth.authorize([])).next).toHaveBeenCalled();
  });

  it('401 without a token', () => {
    const { res, next } = run(auth.authorize(['user']));
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('403 for the wrong role', () => {
    const { res, next } = run(auth.authorize(['admin']), { authorization: bearer(claims) });
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('sets x-user-* from the verified token', () => {
    const { req, next } = run(auth.authorize(['user', 'admin']), { authorization: bearer(claims) });
    expect(next).toHaveBeenCalled();
    expect(req.headers).toMatchObject({ 'x-user-id': 'u1', 'x-user-email': 'user@shop.test', 'x-user-role': 'user' });
  });
});

describe('login', () => {
  it('401 with the same message for a wrong password and an unknown email', () => {
    const a = run(auth.login, {}, { email: 'user@shop.test', password: 'nope' }).res;
    const b = run(auth.login, {}, { email: 'nobody@shop.test', password: 'nope' }).res;
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('returns a token whose claims carry the role', () => {
    const { res } = run(auth.login, {}, { email: 'admin@shop.test', password: 'admin123' });
    expect(auth.verifyToken(`Bearer ${res.body.accessToken}`)).toMatchObject({ role: 'admin' });
  });
});

describe('route table (config.json)', () => {
  it('every route points to a known service', () => {
    for (const r of config.routes) expect(Object.keys(config.services)).toContain(r.service);
  });

  it('keeps internal endpoints internal: POST /inventories is not routed', () => {
    expect(config.routes.some((r) => r.method === 'POST' && r.path === '/inventories')).toBe(false);
  });

  it('all writes require a role', () => {
    for (const r of config.routes.filter((r) => r.method !== 'GET')) expect(r.roles.length).toBeGreaterThan(0);
  });
});
