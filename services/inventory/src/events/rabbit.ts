import amqp, { type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import type { z } from 'zod';

/**
 * Tiny RabbitMQ helper. The SAME file lives in inventory and order
 * (no shared package on purpose: services share contracts, not code).
 *
 * - connects with retry, and reconnects if the broker goes away,
 *   so the service never crashes just because RabbitMQ is slow to start
 * - publishes persistent JSON with publisher confirms (the broker has it on disk)
 * - acks a message ONLY after the handler finished (= after its DB commit).
 *   A crash before that → the broker redelivers → handlers must be idempotent.
 */
const URL = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@rabbitmq:5672';
export const EXCHANGE = process.env.RABBITMQ_EXCHANGE ?? 'ecommerce.events';
const RETRY_MS = 3000;

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
      }
      await ch.prefetch(10); // at most 10 unacked messages in flight per consumer
      for (const s of subscriptions) await consume(ch, s);

      conn.on('error', (e) => console.error(`[rabbit] connection error: ${e.message}`));
      conn.on('close', () => {
        channel = null;
        conn = null;
        if (closing) return;
        console.warn(`[rabbit] connection lost, reconnecting in ${RETRY_MS}ms`);
        void sleep(RETRY_MS).then(connectRabbit);
      });
      channel = ch;
      console.log(`[rabbit] connected, exchange "${EXCHANGE}", consuming: ${subscriptions.map((s) => s.queue).join(', ') || 'none'}`);
      return;
    } catch (e) {
      console.warn(`[rabbit] connect failed (${(e as Error).message}), retrying in ${RETRY_MS}ms`);
      await conn?.close().catch(() => {});
      conn = null;
      await sleep(RETRY_MS);
    }
  }
}

async function consume(ch: ConfirmChannel, { queue, schema, handler }: Subscription) {
  // ack/nack throw if the channel died meanwhile. That's fine: unacked → redelivered.
  const settle = (fn: () => void) => {
    try {
      fn();
    } catch {}
  };

  await ch.consume(queue, async (msg: ConsumeMessage | null) => {
    if (!msg) return; // consumer cancelled by the broker
    const key = msg.fields.routingKey;

    let data: unknown;
    try {
      data = schema.parse(JSON.parse(msg.content.toString()));
    } catch (e) {
      // A malformed message will never succeed: drop it instead of looping forever.
      // (Phase 8 sends these to a dead-letter queue instead.)
      console.error(`[rabbit] ${queue}: invalid "${key}" message dropped: ${(e as Error).message}`);
      settle(() => ch.nack(msg, false, false));
      return;
    }

    try {
      await handler(data, key);
      settle(() => ch.ack(msg));
    } catch (e) {
      // Probably temporary (DB down, deadlock...). Wait a bit, then put it back in the queue.
      console.error(`[rabbit] ${queue}: "${key}" handler failed, requeue in ${RETRY_MS}ms: ${(e as Error).message}`);
      await sleep(RETRY_MS);
      settle(() => ch.nack(msg, false, true));
    }
  });
}

/** Publish and wait until the broker confirms it stored the message. Throws if not connected. */
export async function publish(routingKey: string, payload: { eventId: string; [field: string]: unknown }): Promise<void> {
  const ch = channel;
  if (!ch) throw new Error('RabbitMQ not connected');
  ch.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)), {
    persistent: true, // survives a broker restart (the queue is durable too)
    contentType: 'application/json',
    messageId: payload.eventId,
    timestamp: Date.now(),
  });
  await ch.waitForConfirms();
  console.log(`[rabbit] published ${routingKey} ${payload.eventId}`);
}

export async function closeRabbit() {
  closing = true;
  await conn?.close().catch(() => {});
}
