import { describe, expect, it } from 'vitest';
import { createProductSchema, updateProductSchema } from '../src/schemas';

const base = { sku: 'MUG-01', name: 'Mug', price: '8.00' };

describe('createProductSchema', () => {
  it('fills defaults: DRAFT, no stock', () => {
    expect(createProductSchema.parse(base)).toMatchObject({ status: 'DRAFT', quantity: 0, price: '8.00' });
  });

  it('keeps price as a string, accepting a number too', () => {
    expect(createProductSchema.parse({ ...base, price: 19.99 }).price).toBe('19.99');
  });

  it.each(['19.999', '-1', 'abc', '123456789'])('rejects price %s', (price) => {
    expect(() => createProductSchema.parse({ ...base, price })).toThrow();
  });
});

describe('updateProductSchema', () => {
  // Regression: built from the create schema, Zod 4's .partial() kept .default('DRAFT'),
  // so EVERY partial update silently un-published the product.
  it('does not inject defaults into a partial update', () => {
    const parsed = updateProductSchema.parse({ name: 'New name' });
    expect(parsed).toEqual({ name: 'New name' });
    expect(parsed).not.toHaveProperty('status');
  });

  it('rejects an empty update', () => {
    expect(() => updateProductSchema.parse({})).toThrow();
  });

  it('ignores stock: quantity is not a product field', () => {
    expect(updateProductSchema.parse({ name: 'x', quantity: 99 })).not.toHaveProperty('quantity');
  });
});
