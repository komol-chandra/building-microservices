/**
 * Key rotation:  docker compose exec auth-service yarn -s rotate-key
 *   (prod image has no tsx: docker compose exec auth-service node dist/scripts/rotate-key.js)
 *
 * 1. Creates a new key pair. The old key stays ACTIVE (still in the JWKS),
 *    so tokens it already signed keep verifying until they expire.
 * 2. Restart auth-service → it signs new tokens with the new key.
 * 3. The gateway sees an unknown `kid` in the first new token, refetches the
 *    JWKS once, and from then on knows both keys. No gateway restart.
 * 4. After the old tokens have expired (JWT_EXPIRES_IN), retire the old key:
 *      UPDATE "SigningKey" SET "retiredAt" = now() WHERE kid = '<old kid>';
 */
import { createKey } from '../keys';
import { prisma } from '../prisma';

createKey()
  .then((kid) => console.log(`new key ${kid} created. Restart auth-service to sign with it.`))
  .finally(() => prisma.$disconnect());
