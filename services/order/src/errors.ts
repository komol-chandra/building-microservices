import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';

/** Throw this from a handler to send a specific HTTP status. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const ERROR_NAMES: Record<number, string> = {
  400: 'BadRequest',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'NotFound',
  409: 'Conflict',
  503: 'ServiceUnavailable',
};

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json({ error: 'NotFound', message: `No route ${req.method} ${req.path}` });
};

/**
 * Central error handler. Express 5 forwards errors thrown in async handlers here,
 * so controllers never need try/catch. One place decides the error JSON shape.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'ValidationError',
      message: 'Invalid request',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: ERROR_NAMES[err.status] ?? 'HttpError', message: err.message, details: err.details });
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: 'Conflict', message: `Unique constraint failed on ${String(err.meta?.target)}` });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: 'NotFound', message: 'Record not found' });
      return;
    }
  }
  console.error(err);
  res.status(500).json({ error: 'InternalError', message: 'Something went wrong' });
};
