import { randomUUID } from 'node:crypto';
import amqp, { type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { ZodError, type z } from 'zod';
import { log, requestId, withRequestId } from '../context';

/**
 * Tiny RabbitMQ helper. The SAME file lives in inventory and order
 * (no shared package on purpose: services share contracts, not code).
 *
 * - connects with retry, and reconnects if the broker goes away,
 *   so the service never crashes just because RabbitMQ is slow to start
 * - publishes persistent JSON with publisher confirms (the broker has it on disk)
 * - acks a message ONLY after the handler finished (= after its DB commit).
 *   A crash before that → the broker redelivers → handlers must be idempotent.
 * - failed handler → retry after a delay (via a ".retry" queue), up to MAX_ATTEMPTS,
 *   then park it in a ".dlq" (dead-letter queue) for a human to look at
 * - carries the correlation id (AMQP `correlationId` property) across services
 *
 * For every consumed queue Q there are three queues:
 *
 *   Q        ← bound to the exchange; the consumer reads here
 *   Q.retry  ← no consumer. Messages wait RETRY_DELAY_MS (x-message-ttl), then
 *              RabbitMQ "dead-letters" them back into Q (x-dead-letter-*). That's the delay.
 *   Q.dlq    ← no consumer. Poison messages end here. Inspect them in the management UI
 *              (Queues → Q.dlq → Get messages), fix the cause, then "Move messages" back to Q.
 */
const URL = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@rabbitmq:5672';
export const EXCHANGE = process.env.RABBITMQ_EXCHANGE ?? 'ecommerce.events';
const RECONNECT_MS = 3000;
// A queue argument: RabbitMQ refuses to re-declare a queue with different arguments,
// so changing this means deleting the *.retry queues first.
const RETRY_DELAY_MS = 5000;
const MAX_ATTEMPTS = Number(process.env.RABBITMQ_MAX_ATTEMPTS ?? 5);

/**
 * The whole topology, declared by EVERY service on connect (declaring is idempotent).
 * If only the consumer declared its queue, an event published before that consumer
 * ever started would match no queue and be silently dropped.
 */
const TOPOLOGY = [
  { queue: 'inventory.order-placed', bindingKey: 'order.placed' },
  { queue: 'order.inventory-result', bindingKey: 'inventory.*' },
] as const;

type QueueName = (typeof TOPOLOGY)[number]['queue'];
type Connection = Awaited<ReturnType<typeof amqp.connect>>;
interface Subscription {
  queue: QueueName;
  schema: z.ZodType;
  handler: (data: any, routingKey: string) => Promise<void>;
}

// Our own headers. They survive the trip through the .retry queue.
const H_ROUTING_KEY = 'x-original-routing-key'; // after a retry the message arrives via the default exchange
const H_ATTEMPT = 'x-attempt'; //                  1 = first delivery
const H_ERROR = 'x-last-error'; //                 why it failed last time (visible in the UI)

let conn: Connection | null = null;
let channel: ConfirmChannel | null = null;
let closing = false;
const subscriptions: Subscription[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const isRabbitUp = () => channel !== null;

/** Register a consumer. Call before connectRabbit(); it is re-attached on every reconnect. */
export function subscribe<S extends z.ZodType>(
  queue: QueueName,
  schema: S,
  handler: (data: z.infer<S>, routingKey: string) => Promise<void>,
) {
  subscriptions.push({ queue, schema, handler });
}

/** Runs until connected. Don't await it at startup: HTTP should serve while Rabbit is down. */
export async function connectRabbit(): Promise<void> {
  while (!closing) {
    try {
      conn = await amqp.connect(URL);
      const ch = await conn.createConfirmChannel();
      await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
      for (const { queue, bindingKey } of TOPOLOGY) {
        await ch.assertQueue(queue, { durable: true });
        await ch.bindQueue(queue, EXCHANGE, bindingKey);
        await ch.assertQueue(`${queue}.retry`, {
          durable: true,
          arguments: {
            'x-message-ttl': RETRY_DELAY_MS,
            'x-dead-letter-exchange': '', // the default exchange routes by queue name...
            'x-dead-letter-routing-key': queue, // ...so expired messages go back to Q
          },
        });
        await ch.assertQueue(`${queue}.dlq`, { durable: true });
      }
      await ch.prefetch(10); // at most 10 unacked messages in flight per consumer
      for (const s of subscriptions) await consume(ch, s);

      conn.on('error', (e) => log.error(`[rabbit] connection error: ${e.message}`));
      conn.on('close', () => {
        channel = null;
        conn = null;
        if (closing) return;
        log.warn(`[rabbit] connection lost, reconnecting in ${RECONNECT_MS}ms`);
        void sleep(RECONNECT_MS).then(connectRabbit);
      });
      channel = ch;
      log.info(`[rabbit] connected, exchange "${EXCHANGE}", consuming: ${subscriptions.map((s) => s.queue).join(', ') || 'none'}`);
      return;
    } catch (e) {
      log.warn(`[rabbit] connect failed (${(e as Error).message}), retrying in ${RECONNECT_MS}ms`);
      await conn?.close().catch(() => {});
      conn = null;
      await sleep(RECONNECT_MS);
    }
  }
}

async function consume(ch: ConfirmChannel, { queue, schema, handler }: Subscription) {
  await ch.consume(queue, async (msg: ConsumeMessage | null) => {
    if (!msg) return; // consumer cancelled by the broker
    const headers = msg.properties.headers ?? {};
    const key = String(headers[H_ROUTING_KEY] ?? msg.fields.routingKey);
    const attempt = Number(headers[H_ATTEMPT] ?? 1);
    const correlationId = msg.properties.correlationId || msg.properties.messageId || randomUUID();

    await withRequestId(correlationId, async () => {
      let data: unknown;
      try {
        data = schema.parse(JSON.parse(msg.content.toString()));
      } catch (e) {
        // A malformed message will never succeed: retrying is pointless → straight to the DLQ.
        const why = e instanceof ZodError ? e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') : (e as Error).message;
        log.error(`[rabbit] ${queue}: invalid "${key}" message → ${queue}.dlq: ${why}`);
        await moveTo(ch, msg, `${queue}.dlq`, key, attempt, `invalid message: ${why}`);
        return;
      }

      try {
        await handler(data, key);
        try {
          ch.ack(msg);
        } catch {} // channel died meanwhile: unacked → redelivered → idempotent handler skips it
      } catch (e) {
        // Probably temporary (DB down, deadlock...). Retry later, unless we've tried enough.
        // Prisma errors are multi-line (code excerpt first): the last line says what went wrong.
        const error = (e as Error).message.trim().split('\n').pop()!.trim();
        if (attempt >= MAX_ATTEMPTS) {
          log.error(`[rabbit] ${queue}: "${key}" failed ${attempt}× → ${queue}.dlq: ${error}`);
          await moveTo(ch, msg, `${queue}.dlq`, key, attempt, error);
        } else {
          log.warn(`[rabbit] ${queue}: "${key}" failed (attempt ${attempt}/${MAX_ATTEMPTS}), retry in ${RETRY_DELAY_MS}ms: ${error}`);
          await moveTo(ch, msg, `${queue}.retry`, key, attempt + 1, error);
        }
      }
    });
  });
}

/**
 * Copy the message into another queue, THEN ack the original.
 * Order matters: if we crash between the two, the message exists twice
 * (fine, handlers are idempotent) instead of zero times (lost).
 */
async function moveTo(ch: ConfirmChannel, msg: ConsumeMessage, target: string, key: string, attempt: number, error: string) {
  const { 'x-death': _death, ...headers } = msg.properties.headers ?? {}; // RabbitMQ's own bookkeeping; grows every retry
  try {
    ch.sendToQueue(target, msg.content, {
      persistent: true,
      contentType: msg.properties.contentType,
      messageId: msg.properties.messageId,
      correlationId: msg.properties.correlationId,
      timestamp: msg.properties.timestamp,
      headers: { ...headers, [H_ROUTING_KEY]: key, [H_ATTEMPT]: attempt, [H_ERROR]: error.slice(0, 500) },
    });
    await ch.waitForConfirms();
    ch.ack(msg);
  } catch (e) {
    // Channel/broker gone. The original is still unacked → redelivered after reconnect. Nothing lost.
    log.error(`[rabbit] could not move message to ${target}: ${(e as Error).message}`);
  }
}

/**
 * Publish and wait until the broker confirms it stored the message. Throws if not connected.
 * The correlation id defaults to the current request's id (see context.ts).
 */
export async function publish(
  routingKey: string,
  payload: { eventId: string; [field: string]: unknown },
  opts: { correlationId?: string } = {},
): Promise<void> {
  const ch = channel;
  if (!ch) throw new Error('RabbitMQ not connected');
  ch.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)), {
    persistent: true, // survives a broker restart (the queue is durable too)
    contentType: 'application/json',
    messageId: payload.eventId,
    correlationId: opts.correlationId ?? requestId(),
    timestamp: Date.now(),
  });
  await ch.waitForConfirms();
  log.info(`[rabbit] published ${routingKey} ${payload.eventId}`);
}

export async function closeRabbit() {
  closing = true;
  await conn?.close().catch(() => {});
}
