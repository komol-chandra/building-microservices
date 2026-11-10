import type { Request, RequestHandler } from 'express';
import { HttpError } from './errors';

export interface Identity {
  id: string;
  email: string;
  name: string;
  role: string;
}

/**
 * The gateway verifies the JWT and sets x-user-* headers (after stripping any
 * the client sent). This service trusts them, which is only safe because it
 * publishes no port: nothing outside the Docker network can reach it.
 *
 * If x-user-id is missing, the request didn't come through an authenticated
 * gateway route → 401 instead of saving an order for "nobody".
 */
export const requireIdentity: RequestHandler = (req, _res, next) => {
  if (!req.header('x-user-id')) throw new HttpError(401, 'Missing user identity (call through the gateway)');
  next();
};

export function identity(req: Request): Identity {
  return {
    id: req.header('x-user-id')!,
    email: req.header('x-user-email') ?? '',
    name: req.header('x-user-name') ?? '',
    role: req.header('x-user-role') ?? 'user',
  };
}
