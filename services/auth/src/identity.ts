import type { RequestHandler } from 'express';
import { HttpError } from './errors';

/**
 * Same trust model as the other services: the gateway verified the token and
 * set x-user-* (after stripping any the client sent). This service publishes
 * no port, so those headers can only come from the gateway.
 */
export const requireIdentity: RequestHandler = (req, _res, next) => {
  if (!req.header('x-user-id')) throw new HttpError(401, 'Missing user identity (call through the gateway)');
  next();
};

/** Defense in depth: the gateway already checks roles, the service checks again. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.header('x-user-id')) throw new HttpError(401, 'Missing user identity (call through the gateway)');
  if (req.header('x-user-role') !== 'admin') throw new HttpError(403, 'Requires role: admin');
  next();
};
