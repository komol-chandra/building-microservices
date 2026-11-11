import { Prisma } from '@prisma/client';

/**
 * Pure order math: no DB, no HTTP. Kept apart from the controller so it can be
 * unit tested (test/pricing.test.ts) and reasoned about on its own.
 *
 * Money is ALWAYS Decimal, never a JS float: 0.1 + 0.2 !== 0.3 in floats.
 */
const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

/** Round to cents, half-up (2.345 → 2.35), the way a shop receipt does. */
export const money = (d: Decimal): Decimal => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** 2× mug + 3× mug in one request = one line of 5× mug. Keeps first-seen order. */
export function mergeItems(items: Array<{ productId: string; quantity: number }>): Map<string, number> {
  const qtyById = new Map<string, number>();
  for (const i of items) qtyById.set(i.productId, (qtyById.get(i.productId) ?? 0) + i.quantity);
  return qtyById;
}

export interface PricedLine {
  price: Decimal;
  quantity: number;
  total: Decimal;
}

export interface Totals {
  subtotal: Decimal;
  discount: Decimal;
  tax: Decimal;
  grandTotal: Decimal;
}

/** price × quantity, rounded to cents. */
export function priceLine(price: string | Decimal, quantity: number): PricedLine {
  const p = new Decimal(price);
  return { price: p, quantity, total: money(p.mul(quantity)) };
}

/**
 *   subtotal   = Σ line totals
 *   tax        = round((subtotal − discount) × taxRate)
 *   grandTotal = subtotal − discount + tax
 * Discount is fixed at 0 for now (no coupons yet).
 */
export function computeTotals(lines: PricedLine[], taxRate: string | Decimal, discount: Decimal = new Decimal(0)): Totals {
  const subtotal = lines.reduce((sum, li) => sum.add(li.total), new Decimal(0));
  const taxable = subtotal.sub(discount);
  const tax = money(taxable.mul(taxRate));
  return { subtotal, discount, tax, grandTotal: taxable.add(tax) };
}
