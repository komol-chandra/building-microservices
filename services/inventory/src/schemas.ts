import { z } from 'zod';

export const idParam = z.object({ id: z.uuid() });
export const productIdParam = z.object({ productId: z.string().min(1) });

// Called by product-service when a product is created (Phase 2).
export const createInventorySchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().min(0).default(0),
});

// Admin stock adjustment. RESERVE/RELEASE are NOT allowed here:
// only the order saga (Phase 5) may reserve stock.
export const updateStockSchema = z.object({
  actionType: z.enum(['IN', 'OUT']),
  quantity: z.number().int().positive(),
  reason: z.string().max(255).optional(),
});

export const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
