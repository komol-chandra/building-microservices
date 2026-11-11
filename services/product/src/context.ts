import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * Correlation id ("request id"): ONE id that follows a user action through
 * every service, HTTP call and RabbitMQ message, so you can grep it in all logs:
 *
 *   docker compose logs | grep <id>
 *
 * The gateway creates it (x-request-id). Each service:
 *   - reads it from the incoming request (or message's correlationId)
 *   - keeps it in AsyncLocalStorage: like a thread-local, it survives every
 *     `await` of that request, so no function needs an extra parameter
 *   - adds it to outgoing HTTP calls and published messages
 *   - prints it on every log line (log.info / log.warn / log.error)
 *
 * The same file lives in every service (shared contract, not shared code).
 */
const store = new AsyncLocalStorage<{ requestId: string }>();

export const requestId = (): string | undefined => store.getStore()?.requestId;

/** Run `fn` with this id as the current correlation id (used by message consumers). */
export const withRequestId = <T>(id: string, fn: () => T): T => store.run({ requestId: id }, fn);

/** Express: take x-request-id from the caller (or make one), echo it back, keep it for this request. */
export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const id = req.header('x-request-id') || randomUUID();
  req.headers['x-request-id'] = id; // so morgan's :req[x-request-id] sees it too
  res.setHeader('x-request-id', id);
  store.run({ requestId: id }, next);
};

const line = (msg: string) => {
  const id = requestId();
  return id ? `[${id}] ${msg}` : msg;
};

export const log = {
  info: (msg: string) => console.log(line(msg)),
  warn: (msg: string) => console.warn(line(msg)),
  error: (msg: string) => console.error(line(msg)),
};

/** morgan format with the correlation id at the end. */
export const MORGAN_FORMAT = ':method :url :status :response-time ms rid=:req[x-request-id]';
