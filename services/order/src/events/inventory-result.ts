import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { log } from '../context';

// Contract of inventory.reserved / inventory.failed (extra fields like shortages are ignored).
export const inventoryResultSchema = z.object({
  eventId: z.string().min(1),
  orderId: z.string().min(1),
  reason: z.string().optional(),
});

/**
 * Last saga step: inventory.reserved → CONFIRMED, inventory.failed → FAILED.
 *
 * Only a PENDING order moves. A late or out-of-order event can't flip an
 * order that already reached a final state.
 */
export async function handleInventoryResult(evt: z.infer<typeof inventoryResultSchema>, routingKey: string) {
  if (routingKey !== 'inventory.reserved' && routingKey !== 'inventory.failed') {
    log.warn(`[order] ignoring unknown event ${routingKey}`); // inventory.* may grow new events later
    return;
  }
  const confirmed = routingKey === 'inventory.reserved';

  try {
    const moved = await prisma.$transaction(async (tx) => {
      await tx.processedEvent.create({ data: { eventId: evt.eventId } }); // duplicate → P2002 → whole tx rolls back
      const changed = await tx.order.updateMany({
        where: { id: evt.orderId, status: 'PENDING' },
        data: confirmed
          ? { status: 'CONFIRMED' }
          : { status: 'FAILED', failureReason: evt.reason ?? 'Inventory could not reserve stock' },
      });
      if (changed.count === 0) {
        // The order already has a final status. Since the outbox, createOrder never fails an order
        // on a publish error, so this means: a late duplicate, an unknown orderId, or an order
        // changed by hand. (If it's a reserve, that stock is now held for an order that won't ship.)
        log.warn(`[order] ${routingKey} for order ${evt.orderId}, but it is not PENDING: ignored`);
      }
      return changed.count > 0;
    });
    if (moved) log.info(`[order] order ${evt.orderId} → ${confirmed ? 'CONFIRMED' : 'FAILED'}`);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      log.info(`[order] duplicate ${routingKey} ${evt.eventId}, already processed`);
      return; // handled before → ack, change nothing
    }
    throw e;
  }
}
