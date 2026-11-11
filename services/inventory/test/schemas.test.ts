import { describe, expect, it } from 'vitest';
import { createInventorySchema, updateStockSchema } from '../src/schemas';
import { orderPlacedSchema } from '../src/events/order-placed';

describe('updateStockSchema (admin API)', () => {
  it('accepts IN and OUT', () => {
    expect(updateStockSchema.parse({ actionType: 'IN', quantity: 5 })).toEqual({ actionType: 'IN', quantity: 5 });
    expect(updateStockSchema.parse({ actionType: 'OUT', quantity: 1, reason: 'broken' }).reason).toBe('broken');
  });

  it.each(['RESERVE', 'RELEASE'])('rejects %s: only the order saga may reserve/release', (actionType) => {
    expect(() => updateStockSchema.parse({ actionType, quantity: 1 })).toThrow();
  });

  it('rejects zero / negative / fractional quantities', () => {
    for (const quantity of [0, -1, 1.5]) expect(() => updateStockSchema.parse({ actionType: 'IN', quantity })).toThrow();
  });
});

describe('createInventorySchema', () => {
  it('defaults to zero stock', () => {
    expect(createInventorySchema.parse({ productId: 'p1' })).toEqual({ productId: 'p1', quantity: 0 });
  });
});

describe('orderPlacedSchema (event contract)', () => {
  const ok = { eventId: 'e1', orderId: 'o1', items: [{ productId: 'p1', quantity: 2 }] };

  it('accepts a valid order.placed', () => {
    expect(orderPlacedSchema.parse(ok)).toEqual(ok);
  });

  it('rejects messages that would go to the DLQ', () => {
    expect(() => orderPlacedSchema.parse({ hello: 'garbage' })).toThrow();
    expect(() => orderPlacedSchema.parse({ ...ok, items: [] })).toThrow();
    expect(() => orderPlacedSchema.parse({ ...ok, items: [{ productId: 'p1', quantity: 0 }] })).toThrow();
  });
});
