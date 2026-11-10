import { z } from 'zod';

// Accept 19.99 or "19.99"; keep it as a string so no float rounding ever happens.
const money = z
  .union([z.number(), z.string()])
  .transform((v) => String(v))
  .refine((v) => /^\d{1,8}(\.\d{1,2})?$/.test(v), 'Price must be a positive amount with at most 2 decimals');

const status = z.enum(['DRAFT', 'PUBLISHED', 'UNLISTED']);

export const idParam = z.object({ id: z.uuid() });

// Base fields WITHOUT defaults. Update must not inherit create's defaults:
// with .default('DRAFT'), Zod would fill status=DRAFT on every partial update
// even when the client never sent it (a real bug we hit while testing this phase).
const productFields = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(255),
  description: z.string().max(5000).optional(),
  price: money,
  status,
});

export const createProductSchema = productFields.extend({
  status: status.default('DRAFT'),
  // Initial stock: product-service doesn't store it, it passes it on to inventory-service.
  quantity: z.number().int().min(0).default(0),
});

// Stock is NOT editable here. Stock changes go to inventory-service (PUT /inventories/:id).
export const updateProductSchema = productFields
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Send at least one field to update');

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: status.optional(),
});
