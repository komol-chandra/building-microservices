import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { prisma } from '../prisma';
import { HttpError } from '../errors';
import { identity } from '../identity';
import { requestId } from '../context';
import { createOrderSchema, idParam, listQuery } from '../schemas';
import { getProduct } from '../clients/product';
import { computeTotals, mergeItems, priceLine } from '../pricing';
import { kickOutbox } from '../events/outbox';

const TAX_RATE = process.env.TAX_RATE ?? '0.05';

/**
 * POST /orders  { items: [{ productId, quantity }] }
 *
 *   1. merge duplicate productIds (2× "mug" + 3× "mug" = 5× "mug")
 *   2. fetch every product from product-service, in parallel
 *   3. reject unknown or non-PUBLISHED products
 *   4. copy name/sku/price into line items (SNAPSHOT) and compute totals with Decimal
 *   5. ONE transaction: Order + LineItems + the order.placed event in the OUTBOX
 *   6. nudge the outbox relay, answer 201 PENDING
 *
 * We do NOT publish to RabbitMQ here. The relay (events/outbox.ts) does, right
 * after commit. So if RabbitMQ is down the order is still accepted (PENDING) and
 * its event goes out when the broker is back: no lost events, no "order saved
 * but never sent" state. inventory's answer (events/inventory-result.ts) later
 * moves the order to CONFIRMED or FAILED.
 */
export async function createOrder(req: Request, res: Response) {
  const { items } = createOrderSchema.parse(req.body);
  const user = identity(req);

  const qtyById = mergeItems(items);
  const ids = [...qtyById.keys()];
  const products = await Promise.all(ids.map(getProduct));

  const unavailable = ids.filter((id, n) => products[n]?.status !== 'PUBLISHED');
  if (unavailable.length) throw new HttpError(400, 'Some products are not available', { productIds: unavailable });

  const lineItems = products.map((p) => ({
    productId: p!.id,
    productName: p!.name,
    sku: p!.sku,
    ...priceLine(p!.price, qtyById.get(p!.id)!),
  }));
  const totals = computeTotals(lineItems, TAX_RATE);

  const order = await prisma.$transaction(async (tx) => {
    const saved = await tx.order.create({
      data: {
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        ...totals,
        items: { create: lineItems },
      },
      include: { items: true },
    });

    // Saga step 1, saved as a row (not sent yet): commits together with the order.
    const eventId = randomUUID();
    await tx.outboxEvent.create({
      data: {
        id: eventId,
        routingKey: 'order.placed',
        correlationId: requestId(),
        payload: {
          eventId,
          orderId: saved.id,
          items: saved.items.map((li) => ({ productId: li.productId, quantity: li.quantity })),
          occurredAt: new Date().toISOString(),
        },
      },
    });
    return saved;
  });

  kickOutbox();

  // 201 with status PENDING: accepted, not finished. The client polls GET /orders/:id.
  res.status(201).json(order);
}

/** GET /orders?page=&limit=&status=  — only the caller's own orders. */
export async function listOrders(req: Request, res: Response) {
  const { page, limit, status } = listQuery.parse(req.query);
  const where = { userId: identity(req).id, ...(status ? { status } : {}) };

  const [data, total] = await Promise.all([
    prisma.order.findMany({ where, include: { items: true }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.order.count({ where }),
  ]);

  res.json({ data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

/**
 * GET /orders/:id
 * Scoped by userId in the WHERE clause, so another user's order is a 404,
 * not a 403: we don't even confirm that the id exists.
 */
export async function getOrder(req: Request, res: Response) {
  const { id } = idParam.parse(req.params);
  const order = await prisma.order.findFirst({ where: { id, userId: identity(req).id }, include: { items: true } });
  if (!order) throw new HttpError(404, 'Order not found');
  res.json(order);
}
