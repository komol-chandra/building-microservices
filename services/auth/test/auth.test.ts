import { describe, expect, it } from 'vitest';
import { decodeProtectedHeader, exportJWK, generateKeyPair, importJWK, jwtVerify, type JWK } from 'jose';
import { burnTime, hashPassword, verifyPassword } from '../src/passwords';
import { loginSchema, registerSchema } from '../src/schemas';
import { publicUser, signAccessToken } from '../src/tokens';

describe('passwords (scrypt)', () => {
  it('hash ≠ password, and the same password hashes differently each time (salt)', async () => {
    const a = await hashPassword('secret123');
    const b = await hashPassword('secret123');
    expect(a).not.toContain('secret123');
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const h = await hashPassword('secret123');
    expect(await verifyPassword('secret123', h)).toBe(true);
    expect(await verifyPassword('secret124', h)).toBe(false);
  });

  it('a malformed stored hash never verifies', async () => {
    expect(await verifyPassword('x', 'plain-text-password')).toBe(false);
  });

  it('burnTime (unknown email path) just resolves', async () => {
    await expect(burnTime('whatever')).resolves.toBeUndefined();
  });
});

describe('schemas', () => {
  it('register: email is trimmed + lower-cased, role cannot be chosen', () => {
    const parsed = registerSchema.parse({ email: '  Komol@Shop.TEST ', name: ' Komol ', password: 'longenough', role: 'admin' });
    expect(parsed).toEqual({ email: 'komol@shop.test', name: 'Komol', password: 'longenough' });
  });

  it('register: short password / empty name rejected', () => {
    expect(() => registerSchema.parse({ email: 'a@b.co', name: 'A', password: 'short' })).toThrow();
    expect(() => registerSchema.parse({ email: 'a@b.co', name: '  ', password: 'longenough' })).toThrow();
  });

  it('login: email is normalized the same way as on register', () => {
    expect(loginSchema.parse({ email: 'USER@shop.test', password: 'x' }).email).toBe('user@shop.test');
  });
});

describe('access token', () => {
  it('RS256 with kid; verifies with the PUBLIC key only; carries the claims', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const user = { id: 'u1', email: 'a@b.co', name: 'A', role: 'admin' as const };
    const token = await signAccessToken(user, { kid: 'k1', key: privateKey });

    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'RS256', kid: 'k1' });
    // What the gateway does: only the public JWK, round-tripped like the JWKS endpoint serves it.
    const pubJwk = (await exportJWK(publicKey)) as JWK;
    expect(pubJwk.d).toBeUndefined(); // no private part in the public JWK
    const { payload } = await jwtVerify(token, await importJWK(pubJwk, 'RS256'), { issuer: 'auth-service', audience: 'shop' });
    expect(payload).toMatchObject({ sub: 'u1', email: 'a@b.co', role: 'admin' });
  });

  it('publicUser never leaks the password hash', () => {
    const u = publicUser({ id: 'u1', email: 'a@b.co', name: 'A', role: 'user', passwordHash: 'scrypt$...' } as any);
    expect(u).toEqual({ sub: 'u1', email: 'a@b.co', name: 'A', role: 'user' });
  });
});
