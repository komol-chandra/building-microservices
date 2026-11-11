import { SignJWT, type KeyLike } from 'jose';
import type { Role } from '@prisma/client';

export const ISSUER = process.env.JWT_ISSUER ?? 'auth-service';
export const AUDIENCE = process.env.JWT_AUDIENCE ?? 'shop';
export const EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '1h';

export interface TokenUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/** The user as the client sees it (same fields as the token claims; `sub` = user id). */
export const publicUser = (u: TokenUser) => ({ sub: u.id, email: u.email, name: u.name, role: u.role });

/**
 * Access token claims:
 *   sub  = user id (standard "subject" claim)
 *   iss  = who issued it   → the gateway accepts only our issuer
 *   aud  = who it is for   → a token minted for another app is rejected
 *   exp  = expiry          → a stolen token stops working after EXPIRES_IN
 *   email, name, role      → copied into x-user-* headers by the gateway
 *
 * The role inside a token is a SNAPSHOT: if an admin changes someone's role,
 * it takes effect on their next login (or when this token expires).
 */
export function signAccessToken(user: TokenUser, signer: { kid: string; key: KeyLike | Uint8Array }): Promise<string> {
  return new SignJWT({ email: user.email, name: user.name, role: user.role })
    .setProtectedHeader({ alg: 'RS256', kid: signer.kid, typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(EXPIRES_IN)
    .sign(signer.key);
}
