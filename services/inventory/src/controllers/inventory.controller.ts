import type { Request, Response } from 'express';
import { prisma } from '../prisma';
import { HttpError } from '../errors';
import { createInventorySchema, historyQuery, idParam, productIdParam, updateStockSchema } from '../schemas';

// POST /inventories
export async function createInventory(req: Request, res: Response) {
  const { productId, quantity } = createInventorySchema.parse(req.body);

  // Inventory row + its first history row must both exist or both not exist.
  const inventory = await prisma.$transaction(async (tx) => {
    const inv = await tx.inventory.create({ data: { productId, availableQuantity: quantity } });
    if (quantity > 0) {
      await tx.stockHistory.create({
        data: {
          inventoryId: inv.id,
          actionType: 'IN',
          quantityChanged: quantity,
          lastQuantity: 0,
          currentQuantity: quantity,
          reason: 'Initial stock',
        },
      });
    }
    return inv;
  });

  res.status(201).json(inventory);
}

// GET /inventories/:id
export async function getInventory(req: Request, res: Response) {
  const { id } = idParam.parse(req.params);
  const inventory = await prisma.inventory.findUnique({ where: { id } });
  if (!inventory) throw new HttpError(404, 'Inventory not found');
  res.json(inventory);
}

// GET /inventories/product/:productId
export async function getInventoryByProduct(req: Request, res: Response) {
  const { productId } = productIdParam.parse(req.params);
  const inventory = await prisma.inventory.findUnique({ where: { productId } });
  if (!inventory) throw new HttpError(404, 'Inventory not found for this product');
  res.json(inventory);
}

// PUT /inventories/:id   { actionType: IN|OUT, quantity, reason? }
export async function updateStock(req: Request, res: Response) {
  const { id } = idParam.parse(req.params);
  const { actionType, quantity, reason } = updateStockSchema.parse(req.body);

  const result = await prisma.$transaction(async (tx) => {
    // ATOMIC update. We do NOT "read stock, check in JS, then write":
    // two concurrent OUT requests could both read 5 and both remove 5.
    // Instead the condition lives in the WHERE clause, so Postgres checks
    // and changes the row in one step (and locks it until we commit).
    const changed =
      actionType === 'IN'
        ? await tx.inventory.updateMany({
            where: { id },
            data: { availableQuantity: { increment: quantity } },
          })
        : await tx.inventory.updateMany({
            where: { id, availableQuantity: { gte: quantity } },
            data: { availableQuantity: { decrement: quantity } },
          });

    if (changed.count === 0) {
      const existing = await tx.inventory.findUnique({ where: { id } });
      if (!existing) throw new HttpError(404, 'Inventory not found');
      throw new HttpError(409, 'Insufficient stock', {
        available: existing.availableQuantity,
        requested: quantity,
      });
    }

    // Row is locked by our UPDATE, so this read sees exactly our result.
    const inventory = await tx.inventory.findUniqueOrThrow({ where: { id } });
    const current = inventory.availableQuantity;
    const last = actionType === 'IN' ? current - quantity : current + quantity;

    const history = await tx.stockHistory.create({
      data: {
        inventoryId: id,
        actionType,
        quantityChanged: quantity,
        lastQuantity: last,
        currentQuantity: current,
        reason,
      },
    });

    return { inventory, history };
  });

  res.json(result);
}

// GET /inventories/:id/history?limit=50
export async function getHistory(req: Request, res: Response) {
  const { id } = idParam.parse(req.params);
  const { limit } = historyQuery.parse(req.query);

  const exists = await prisma.inventory.count({ where: { id } });
  if (!exists) throw new HttpError(404, 'Inventory not found');

  const histories = await prisma.stockHistory.findMany({
    where: { inventoryId: id },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  res.json({ data: histories, meta: { count: histories.length, limit } });
}
