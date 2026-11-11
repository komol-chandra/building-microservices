import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { HttpError } from '../errors';
import { identity } from '../identity';
import { createOrderSchema, idParam, listQuery } from '../schemas';
import { getProduct } from '../clients/product';
import { publish } from '../events/rabbit';

const Decimal = Prisma.Decimal;
const TAX_RATE = new Decimal(process.env.TAX_RATE ?? '0.05');
const money = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * POST /orders  { items: [{ productId, quantity }] }
 *
 *   1. merge duplicate productIds (2× "mug" + 3× "mug" = 5× "mug")
 *   2. fetch every product from product-service, in parallel
 *   3. reject unknown or non-PUBLISHED products
 *   4. copy name/sku/price into line items (SNAPSHOT) and compute totals with Decimal
 *   5. save Order + LineItems in ONE transaction (same DB → a real transaction works)
 *
 *   6. publish order.placed
 *
 * The order is saved as PENDING. Stock is NOT checked here: the order.placed
 * event asks inventory-service to reserve it, and its answer
 * (events/inventory-result.ts) moves the order to CONFIRMED or FAILED.
 */
export async function createOrder(req: Request, res: Response) {
  const { items } = createOrderSchema.parse(req.body);
  const user = identity(req);

  const qtyById = new Map<string, number>();
  for (const i of items) qtyById.set(i.productId, (qtyById.get(i.productId) ?? 0) + i.quantity);

  const ids = [...qtyById.keys()];
  const products = await Promise.all(ids.map(getProduct));

  const unavailable = ids.filter((id, n) => products[n]?.status !== 'PUBLISHED');
  if (unavailable.length) throw new HttpError(400, 'Some products are not available', { productIds: unavailable });

  const lineItems = products.map((p) => {
    const quantity = qtyById.get(p!.id)!;
    const price = new Decimal(p!.price);
    return { productId: p!.id, productName: p!.name, sku: p!.sku, price, quantity, total: money(price.mul(quantity)) };
  });

  const subtotal = lineItems.reduce((sum, li) => sum.add(li.total), new Decimal(0));
  const discount = new Decimal(0);
  const tax = money(subtotal.sub(discount).mul(TAX_RATE));
  const grandTotal = subtotal.sub(discount).add(tax);

  const order = await prisma.order.create({
    data: {
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      subtotal,
      discount,
      tax,
      grandTotal,
      items: { create: lineItems }, // nested create → Prisma wraps it in one transaction
    },
    include: { items: true },
  });

  // Saga step 1: tell inventory. It answers later with inventory.reserved|failed.
  try {
    await publish('order.placed', {
      eventId: randomUUID(),
      orderId: order.id,
      items: order.items.map((li) => ({ productId: li.productId, quantity: li.quantity })),
      occurredAt: new Date().toISOString(),
    });
  } catch (err) {
    // The order row is committed but the event isn't: nobody would ever reserve
    // its stock, so it would stay PENDING forever. Compensate: fail it now.
    // (Phase 8's outbox saves the event in the same DB transaction instead.)
    console.error(`[order] order.placed publish failed for ${order.id}: ${(err as Error).message}`);
    await prisma.order.update({ where: { id: order.id }, data: { status: 'FAILED', failureReason: 'Could not send order to inventory' } });
    throw new HttpError(503, 'Order system busy, order was not placed. Please retry.');
  }

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
