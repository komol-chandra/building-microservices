import { prisma } from '../prisma';
import { log } from '../context';
import { isRabbitUp, publish } from './rabbit';

/**
 * Outbox RELAY: publishes the events that createOrder saved into OutboxEvent.
 *
 *   loop: SELECT unpublished rows ... FOR UPDATE SKIP LOCKED
 *         publish each (with publisher confirm) → UPDATE publishedAt = now()
 *
 * Delivery is AT LEAST ONCE: if we crash after publishing but before the UPDATE
 * commits, the row is published again on restart. That's fine: inventory
 * dedupes on eventId (its ProcessedEvent table).
 *
 * FOR UPDATE SKIP LOCKED: if you ever run two order-service replicas, each relay
 * grabs a different set of rows instead of both publishing the same ones.
 *
 * Rows are sent oldest first, and the batch stops at the first failure, so
 * events keep their order.
 */
const POLL_MS = Number(process.env.OUTBOX_POLL_MS ?? 1000);
const BATCH = 50;
const KEEP_PUBLISHED_DAYS = 7;
const CLEANUP_EVERY_MS = 60 * 60 * 1000;

interface Row {
  id: string;
  routingKey: string;
  payload: { eventId: string; [k: string]: unknown };
  correlationId: string | null;
}

let running = false;
let again = false;
let stopped = false;
let pollTimer: NodeJS.Timeout | undefined;
let cleanupTimer: NodeJS.Timeout | undefined;

/** Publishes one batch. Returns how many rows went out. */
async function relayBatch(): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Row[]>`
        SELECT "id", "routingKey", "payload", "correlationId"
        FROM "OutboxEvent"
        WHERE "publishedAt" IS NULL
        ORDER BY "createdAt"
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED`;

      let sent = 0;
      for (const row of rows) {
        try {
          await publish(row.routingKey, row.payload, { correlationId: row.correlationId ?? undefined });
        } catch (e) {
          const error = (e as Error).message;
          await tx.outboxEvent.update({ where: { id: row.id }, data: { attempts: { increment: 1 }, lastError: error } });
          log.warn(`[outbox] publish of ${row.routingKey} ${row.id} failed, will retry: ${error}`);
          break; // broker trouble: stop here (keeps the order), the next tick tries again
        }
        await tx.outboxEvent.update({
          where: { id: row.id },
          data: { publishedAt: new Date(), attempts: { increment: 1 }, lastError: null },
        });
        sent++;
      }
      return sent;
    },
    { timeout: 30_000 }, // publishing happens inside the transaction (rows stay locked meanwhile)
  );
}

/** Drain the outbox now. Safe to call any time: concurrent calls are merged into one run. */
export async function relayOutbox(): Promise<void> {
  if (running) {
    again = true; // someone asked while we were busy: do one more pass after this one
    return;
  }
  running = true;
  try {
    do {
      again = false;
      if (!isRabbitUp()) return; // nothing to do until RabbitMQ is back; rows wait safely
      const sent = await relayBatch();
      if (sent === BATCH) again = true; // a full batch: there may be more
    } while (again && !stopped);
  } catch (e) {
    log.error(`[outbox] relay failed: ${(e as Error).message}`);
  } finally {
    running = false;
  }
}

/** Nudge after a new order, so it goes out right away instead of on the next poll. */
export const kickOutbox = () => void relayOutbox();

async function cleanup() {
  const before = new Date(Date.now() - KEEP_PUBLISHED_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.outboxEvent.deleteMany({ where: { publishedAt: { lt: before } } });
  if (count) log.info(`[outbox] deleted ${count} published events older than ${KEEP_PUBLISHED_DAYS} days`);
}

export function startOutboxRelay() {
  const tick = async () => {
    await relayOutbox();
    if (!stopped) pollTimer = setTimeout(tick, POLL_MS);
  };
  void tick();
  cleanupTimer = setInterval(() => void cleanup().catch((e) => log.error(`[outbox] cleanup failed: ${e.message}`)), CLEANUP_EVERY_MS);
  log.info(`[outbox] relay started (poll every ${POLL_MS}ms)`);
}

export function stopOutboxRelay() {
  stopped = true;
  clearTimeout(pollTimer);
  clearInterval(cleanupTimer);
}
