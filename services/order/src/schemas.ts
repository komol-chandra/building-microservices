import { z } from 'zod';

export const idParam = z.object({ id: z.uuid() });

// The client sends ONLY product ids and quantities. Never a price:
// prices come from product-service, so a client can't buy a $500 item for $1.
export const createOrderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: z.number().int().min(1).max(1000),
      }),
    )
    .min(1, 'An order needs at least one item')
    .max(50),
});

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED']).optional(),
});
