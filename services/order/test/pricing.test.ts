import { describe, expect, it } from 'vitest';
import { computeTotals, mergeItems, priceLine } from '../src/pricing';
import { createOrderSchema } from '../src/schemas';
import { inventoryResultSchema } from '../src/events/inventory-result';

describe('mergeItems', () => {
  it('adds up quantities of the same product', () => {
    const m = mergeItems([
      { productId: 'a', quantity: 2 },
      { productId: 'b', quantity: 1 },
      { productId: 'a', quantity: 3 },
    ]);
    expect([...m.entries()]).toEqual([
      ['a', 5],
      ['b', 1],
    ]);
  });
});

describe('priceLine / computeTotals', () => {
  it('multiplies exactly (no float drift)', () => {
    expect(priceLine('19.99', 3).total.toFixed(2)).toBe('59.97');
  });

  it('0.10 + 0.20 is exactly 0.30 (it is not in JS floats)', () => {
    const t = computeTotals([priceLine('0.10', 1), priceLine('0.20', 1)], '0');
    expect(t.subtotal.toFixed(2)).toBe('0.30');
    expect(0.1 + 0.2).not.toBe(0.3); // the reason money is Decimal
  });

  it('rounds tax half-up to cents', () => {
    // 20.90 × 5% = 1.045 → 1.05 (half-up). With floats, (20.9 * 0.05).toFixed(2) is "1.04":
    // the float is really 1.04499999… so a customer would be under-charged a cent.
    const t = computeTotals([priceLine('20.90', 1)], '0.05');
    expect(t.tax.toFixed(2)).toBe('1.05');
    expect(t.grandTotal.toFixed(2)).toBe('21.95');
    expect((20.9 * 0.05).toFixed(2)).toBe('1.04'); // the float bug this avoids
  });

  it('grandTotal = subtotal − discount + tax', () => {
    const t = computeTotals([priceLine('8.00', 2), priceLine('3.25', 4)], '0.05');
    expect(t.subtotal.toFixed(2)).toBe('29.00');
    expect(t.discount.toFixed(2)).toBe('0.00');
    expect(t.tax.toFixed(2)).toBe('1.45');
    expect(t.grandTotal.toFixed(2)).toBe('30.45');
  });
});

describe('createOrderSchema', () => {
  const id = '6f1c1a9e-8d0a-4c55-9a43-0a5a3f3b7c11';

  it('drops a client-sent price: prices only come from product-service', () => {
    const parsed = createOrderSchema.parse({ items: [{ productId: id, quantity: 1, price: '0.01' }] });
    expect(parsed.items[0]).toEqual({ productId: id, quantity: 1 });
  });

  it('rejects empty orders and bad quantities', () => {
    expect(() => createOrderSchema.parse({ items: [] })).toThrow();
    expect(() => createOrderSchema.parse({ items: [{ productId: id, quantity: 0 }] })).toThrow();
    expect(() => createOrderSchema.parse({ items: [{ productId: 'not-a-uuid', quantity: 1 }] })).toThrow();
  });
});

describe('inventoryResultSchema (event contract)', () => {
  it('accepts inventory.failed with extra fields it does not use', () => {
    const evt = { eventId: 'e1', orderId: 'o1', reason: 'Insufficient stock', shortages: [{ productId: 'p', requested: 5, available: 1 }] };
    expect(inventoryResultSchema.parse(evt)).toMatchObject({ eventId: 'e1', orderId: 'o1', reason: 'Insufficient stock' });
  });

  it('rejects a message without eventId (it could not be deduplicated)', () => {
    expect(() => inventoryResultSchema.parse({ orderId: 'o1' })).toThrow();
  });
});
