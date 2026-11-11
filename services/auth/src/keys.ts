import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, importJWK, type JWK, type KeyLike } from 'jose';
import { prisma } from './prisma';
import { log } from './context';

/**
 * RS256 = asymmetric signing:
 *   - the PRIVATE key signs tokens. Only auth-service has it.
 *   - the PUBLIC key verifies them. Anyone may have it (the gateway fetches it from /.well-known/jwks.json).
 *
 * Before Phase 9 the gateway used one shared HS256 secret for both, so anything that
 * could VERIFY a token could also MINT one (e.g. a token with role "admin").
 * Now the gateway can only check tokens, never create them.
 *
 * Each key has a `kid` (key id). It goes into every token's header, so a verifier
 * knows which public key to use, and keys can be rotated: add a new key, keep the
 * old one published until its last tokens expire.
 */
let signer: { kid: string; key: KeyLike | Uint8Array } | undefined;

/** Create and store a new key pair. It becomes the signing key on the next loadSigningKey(). */
export async function createKey(): Promise<string> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
  const kid = randomUUID();
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const privateJwk: JWK = { ...(await exportJWK(privateKey)), kid, alg: 'RS256' };
  await prisma.signingKey.create({ data: { kid, publicJwk: publicJwk as object, privateJwk: privateJwk as object } });
  log.info(`[auth] created signing key ${kid}`);
  return kid;
}

/** On start: use the newest active key; create the first one if the table is empty. */
export async function loadSigningKey(): Promise<void> {
  const newest = () => prisma.signingKey.findFirst({ where: { retiredAt: null }, orderBy: { createdAt: 'desc' } });
  let row = await newest();
  if (!row) {
    await createKey();
    row = await newest();
  }
  signer = { kid: row!.kid, key: await importJWK(row!.privateJwk as unknown as JWK, 'RS256') };
  log.info(`[auth] signing with key ${row!.kid}`);
}

export function signingKey() {
  if (!signer) throw new Error('signing key not loaded');
  return signer;
}

/** Public halves of all active keys. This is the ONLY key material that leaves the service. */
export async function publicJwks(): Promise<{ keys: JWK[] }> {
  const rows = await prisma.signingKey.findMany({ where: { retiredAt: null }, orderBy: { createdAt: 'desc' } });
  return { keys: rows.map((r) => r.publicJwk as unknown as JWK) };
}
