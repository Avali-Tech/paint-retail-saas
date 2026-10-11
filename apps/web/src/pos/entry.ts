import { paiseToRupees, type Discount } from '@paint/shared';
import { parseRupees } from '../lib/inputs.js';
import { parsePositiveQuantity } from '../lib/quantity.js';

// What the cashier types at the counter, read the way a POS reads it.

/** "3*8901234567890" → 3 of that code; "apex" → 1 of it; "3*" alone → quantity 3 and no code. */
export function parseScan(text: string): { quantity: number; code: string } {
  const value = text.trim();
  const star = value.indexOf('*');
  const quantity = star === -1 ? null : parsePositiveQuantity(value.slice(0, star));
  return quantity === null
    ? { quantity: 1, code: value }
    : { quantity, code: value.slice(star + 1).trim() };
}

/**
 * A line discount typed as "10%" (a percentage) or "50" (rupees off the line).
 * Blank clears it; null when it is not a discount the line can take.
 */
export function parseDiscount(
  text: string,
  linePaise: number,
): { readonly discount: Discount | null } | null {
  const value = text.trim();
  if (value === '') return { discount: null };
  const percent = /^(\d{1,3}(?:\.\d{1,2})?)\s*%$/.exec(value);
  if (percent) {
    const basisPoints = Math.round(Number(percent[1]) * 100);
    return basisPoints <= 10_000 ? { discount: { kind: 'percent', basisPoints } } : null;
  }
  const paise = value.includes('%') ? null : parseRupees(value);
  return paise !== null && paise >= 0 && paise <= linePaise
    ? { discount: { kind: 'amount', paise } }
    : null;
}

/** How a discount is typed back into its box: "10%", "50.00", or "". */
export function discountText(discount: Discount | null): string {
  if (discount === null) return '';
  return discount.kind === 'percent'
    ? `${String(discount.basisPoints / 100)}%`
    : paiseToRupees(discount.paise);
}
