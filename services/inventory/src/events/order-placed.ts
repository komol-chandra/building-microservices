import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../prisma';
import { publish } from './rabbit';
import { log } from '../context';

// Contract of the event order-service publishes. Validated: never trust a message blindly.
export const orderPlacedSchema = z.object({
  eventId: z.string().min(1),
  orderId: z.string().min(1),
  items: z.array(z.object({ productId: z.string().min(1), quantity: z.number().int().positive() })).min(1),
});

// A type alias, not an interface: it must fit Prisma's Json column type.
type Shortage = {
  productId: string;
  requested: number;
  available: number;
};

class OutOfStock extends Error {
  constructor(public shortages: Shortage[]) {
    super('Insufficient stock');
  }
}

/**
 * order.placed → reserve stock for ALL items, or for none.
 *
 *   enough stock for every item → available -= qty, reserved += qty, RESERVE history
 *                                 → publish inventory.reserved
 *   any item short              → roll back everything → publish inventory.failed
 *
 * All items in ONE DB transaction: an order is never half-reserved.
 */
export async function handleOrderPlaced(evt: z.infer<typeof orderPlacedSchema>) {
  // Idempotency: seen this event before? Re-send the same answer, change nothing.
  const done = await prisma.processedEvent.findUnique({ where: { eventId: evt.eventId } });
  if (done) {
    log.info(`[inventory] duplicate order.placed ${evt.eventId} (order ${evt.orderId}), re-sending ${done.resultKey}`);
    await publish(done.resultKey, done.result as { eventId: string });
    return;
  }

  // Always lock rows in the same order (by productId). Two orders locking
  // A then B, and B then A, could otherwise deadlock each other.
  const items = [...evt.items].sort((a, b) => a.productId.localeCompare(b.productId));

  let resultKey: string;
  let result: { eventId: string; orderId: string; occurredAt: string; reason?: string; shortages?: Shortage[] };

  try {
    result = await prisma.$transaction(async (tx) => {
      const shortages: Shortage[] = [];

      for (const { productId, quantity } of items) {
        // Same atomic "check in the WHERE clause" trick as PUT /inventories/:id.
        const changed = await tx.inventory.updateMany({
          where: { productId, availableQuantity: { gte: quantity } },
          data: { availableQuantity: { decrement: quantity }, reservedQuantity: { increment: quantity } },
        });
        if (changed.count === 0) {
          const inv = await tx.inventory.findUnique({ where: { productId } });
          shortages.push({ productId, requested: quantity, available: inv?.availableQuantity ?? 0 });
          continue; // keep going so the failure lists EVERY short item
        }

        const inv = await tx.inventory.findUniqueOrThrow({ where: { productId } });
        await tx.stockHistory.create({
          data: {
            inventoryId: inv.id,
            actionType: 'RESERVE',
            quantityChanged: quantity,
            lastQuantity: inv.availableQuantity + quantity,
            currentQuantity: inv.availableQuantity,
            orderId: evt.orderId,
            reason: 'Order placed',
          },
        });
      }

      if (shortages.length) throw new OutOfStock(shortages); // → rolls back the items reserved above

      const reserved = { eventId: randomUUID(), orderId: evt.orderId, occurredAt: new Date().toISOString() };
      // Same transaction as the stock change: both happen, or neither.
      await tx.processedEvent.create({ data: { eventId: evt.eventId, resultKey: 'inventory.reserved', result: reserved } });
      return reserved;
    });
    resultKey = 'inventory.reserved';
  } catch (e) {
    if (!(e instanceof OutOfStock)) throw e; // DB error etc. → message is requeued

    resultKey = 'inventory.failed';
    result = {
      eventId: randomUUID(),
      orderId: evt.orderId,
      occurredAt: new Date().toISOString(),
      reason:
        'Insufficient stock: ' +
        e.shortages.map((s) => `${s.productId} (requested ${s.requested}, available ${s.available})`).join(', '),
      shortages: e.shortages,
    };
    // Nothing changed in stock, but the decision itself is recorded so a duplicate gets the same answer.
    await prisma.processedEvent.create({ data: { eventId: evt.eventId, resultKey, result } });
  }

  // If we crash right here, the message is redelivered and the "done" branch above re-sends it.
  await publish(resultKey, result);
  log.info(`[inventory] order ${evt.orderId}: ${resultKey}`);
}
