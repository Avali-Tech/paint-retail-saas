import { checkPaise, quantityToMilli, roundDiv, toPaise } from './arith.js';
import { GstError } from './errors.js';
import type { AppliedRate, Discount, SupplyType, TaxHeads } from './types.js';

const BASIS = 10_000n;

/** One line as entered: a category, a quantity and a unit price, optionally discounted. */
export interface LineInput {
  readonly categoryCode: string;
  /** Units sold, up to 3 decimals for loose goods (litres, kilograms). */
  readonly quantity: number;
  /** Price of one unit in paise, with or without tax as the invoice says. */
  readonly unitPricePaise: number;
  readonly discount: Discount | null;
}

export interface PricedLine {
  readonly quantityMilli: number;
  /** quantity × unit price, rounded half up to the paisa. */
  readonly grossPaise: number;
  readonly lineDiscountPaise: number;
  /** Gross less the line discount. */
  readonly netPaise: number;
}

/**
 * The discount on `basePaise`: a percentage is rounded half up to the paisa,
 * an amount is taken as given. Neither may exceed the base.
 */
export function discountAmount(basePaise: number, discount: Discount | null): number {
  const base = checkPaise(basePaise, 'Discount base');
  if (discount === null) return 0;
  if (discount.kind === 'percent') {
    const bps = discount.basisPoints;
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) {
      throw new GstError(
        'invalid_discount',
        `Discount must be 0–10000 basis points, got ${String(bps)}`,
      );
    }
    return toPaise(roundDiv(base * BigInt(bps), BASIS));
  }
  const amount = checkPaise(discount.paise, 'Discount');
  if (amount > base) {
    throw new GstError(
      'discount_exceeds_value',
      `Discount ${String(amount)} exceeds ${String(base)} paise`,
    );
  }
  return toPaise(amount);
}

/** Gross, line discount and net of one line, before any invoice discount or tax. */
export function priceLine(line: LineInput): PricedLine {
  const quantity = quantityToMilli(line.quantity);
  const price = checkPaise(line.unitPricePaise, 'Unit price');
  const grossPaise = toPaise(roundDiv(quantity * price, 1000n));
  const lineDiscountPaise = discountAmount(grossPaise, line.discount);
  return {
    quantityMilli: Number(quantity),
    grossPaise,
    lineDiscountPaise,
    netPaise: grossPaise - lineDiscountPaise,
  };
}

/** The tax heads on an exclusive taxable value: each head rounded half up on its own. */
function headsOn(taxable: bigint, rate: AppliedRate, supplyType: SupplyType) {
  const gst = BigInt(rate.rateBasisPoints);
  // CGST and SGST are each half the rate, rounded by the same formula, so they are always equal.
  const half = supplyType === 'intra_state' ? roundDiv(taxable * gst, 2n * BASIS) : 0n;
  const igst = supplyType === 'inter_state' ? roundDiv(taxable * gst, BASIS) : 0n;
  const cess = roundDiv(taxable * BigInt(rate.cessBasisPoints), BASIS);
  return { half, igst, cess, tax: 2n * half + igst + cess };
}

/**
 * The tax on one amount at one rate.
 *
 * - Tax-exclusive: the amount is the taxable value; each head is rounded half up.
 * - Tax-inclusive: the taxable value is back-calculated as amount × 10000 /
 *   (10000 + rate + cess), rounded half up; the heads are taken on that, and the
 *   taxable value is then amount − tax, so taxable + tax equals the shelf price
 *   exactly and the odd paisa lands in the taxable value, never in the price.
 */
export function taxOnAmount(
  amountPaise: number,
  rate: AppliedRate,
  supplyType: SupplyType,
  pricesIncludeTax: boolean,
): TaxHeads {
  const amount = checkPaise(amountPaise, 'Amount');
  const base = pricesIncludeTax
    ? roundDiv(amount * BASIS, BASIS + BigInt(rate.rateBasisPoints + rate.cessBasisPoints))
    : amount;
  const heads = headsOn(base, rate, supplyType);
  const taxable = pricesIncludeTax ? amount - heads.tax : amount;
  if (taxable < 0n) {
    throw new GstError('invalid_amount', `${String(amount)} paise is too small to carry its tax`);
  }
  return {
    taxablePaise: toPaise(taxable),
    cgstPaise: toPaise(heads.half),
    sgstPaise: toPaise(heads.half),
    igstPaise: toPaise(heads.igst),
    cessPaise: toPaise(heads.cess),
  };
}
