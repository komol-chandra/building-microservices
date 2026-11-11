import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt (built into Node, no native build step like bcrypt).
 *
 * scrypt is deliberately SLOW and memory-hungry: fine for one login, very
 * expensive for someone trying billions of guesses against a stolen table.
 * A random salt per user means two users with the same password get different
 * hashes, so precomputed tables don't work.
 *
 * Stored format (all parameters inside, so they can be raised later without
 * breaking old hashes):  scrypt$N$r$p$<salt base64>$<hash base64>
 */
const N = 16384; // CPU/memory cost (2^14) → ~16 MB, ~50 ms
const R = 8;
const P = 1;
const KEYLEN = 64;

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const actual = await scryptAsync(password, salt, expected.length, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(actual, expected); // constant time: timing doesn't leak how many bytes matched
}

/**
 * For "unknown email": still run one scrypt, so a login for an email that
 * doesn't exist takes as long as a wrong password. Otherwise response time
 * tells an attacker which emails are registered.
 */
let dummy: Promise<string> | undefined;
export async function burnTime(password: string): Promise<void> {
  dummy ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(password, await dummy);
}
