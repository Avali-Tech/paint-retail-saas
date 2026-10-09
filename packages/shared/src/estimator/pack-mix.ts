/**
 * The cheapest pack mix that never under-supplies (spec §6.2): an exact
 * dynamic programme over the amount, in steps of the packs' common divisor.
 * Ties go to fewer packs, then to less surplus. Amounts are whole units of one
 * measure: millilitres for paint and primer, grams for putty.
 */
import { at } from '../gst/arith.js';

/** A pack on sale: one active variant of the chosen product, `size` mL or g. */
export interface PackOption {
  readonly variantId: string;
  readonly size: number;
  readonly pricePaise: number;
}

export interface PackMixLine {
  readonly variantId: string;
  readonly size: number;
  readonly unitPricePaise: number;
  readonly quantity: number;
  readonly totalPaise: number;
}

export interface PackMix {
  readonly required: number;
  readonly supplied: number;
  readonly surplus: number;
  readonly totalPaise: number;
  readonly packCount: number;
  /** Largest pack first. */
  readonly lines: readonly PackMixLine[];
}

/** Amounts beyond this many DP steps are refused rather than computed slowly. */
export const MAX_PACK_MIX_STEPS = 2_000_000;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function validate(packs: readonly PackOption[], required: number): void {
  if (!Number.isSafeInteger(required) || required < 0) {
    throw new RangeError('The amount needed must be a whole number');
  }
  for (const pack of packs) {
    if (!Number.isSafeInteger(pack.size) || pack.size <= 0) {
      throw new RangeError(`Pack ${pack.variantId} needs a size above zero`);
    }
    if (!Number.isSafeInteger(pack.pricePaise) || pack.pricePaise < 0) {
      throw new RangeError(`Pack ${pack.variantId} needs a price in whole paise`);
    }
  }
}

/** Returns null when there are no packs to choose from. */
export function cheapestPackMix(packs: readonly PackOption[], required: number): PackMix | null {
  validate(packs, required);
  if (packs.length === 0) {
    return null;
  }
  const step = packs.reduce((divisor, pack) => gcd(divisor, pack.size), 0);
  const sizes = packs.map((pack) => pack.size / step);
  const target = Math.ceil(required / step);
  // Any optimum with surplus ≥ the largest pack could drop that pack, so stop below target + max.
  const limit = target + Math.max(...sizes);
  if (limit > MAX_PACK_MIX_STEPS) {
    throw new RangeError('The amount needed is too large for these pack sizes');
  }
  const cost = new Array<number>(limit).fill(Infinity);
  const count = new Array<number>(limit).fill(Infinity);
  const last = new Array<number>(limit).fill(-1);
  cost[0] = 0;
  count[0] = 0;
  for (let amount = 1; amount < limit; amount += 1) {
    packs.forEach((pack, index) => {
      const from = amount - at(sizes, index);
      if (from < 0 || at(cost, from) === Infinity) return;
      const candidateCost = at(cost, from) + pack.pricePaise;
      const candidateCount = at(count, from) + 1;
      const current = at(cost, amount);
      if (
        candidateCost < current ||
        (candidateCost === current && candidateCount < at(count, amount))
      ) {
        cost[amount] = candidateCost;
        count[amount] = candidateCount;
        last[amount] = index;
      }
    });
  }
  // The largest pack alone reaches target..limit-1, so a best amount is always found.
  let best = limit - 1;
  for (let amount = limit - 1; amount >= target; amount -= 1) {
    const better =
      at(cost, amount) < at(cost, best) ||
      (at(cost, amount) === at(cost, best) && at(count, amount) <= at(count, best));
    if (better) best = amount;
  }
  const quantities = new Array<number>(packs.length).fill(0);
  for (let amount = best; amount > 0; amount -= at(sizes, at(last, amount))) {
    const index = at(last, amount);
    quantities[index] = at(quantities, index) + 1;
  }
  const lines = packs
    .map((pack, index) => ({
      variantId: pack.variantId,
      size: pack.size,
      unitPricePaise: pack.pricePaise,
      quantity: at(quantities, index),
      totalPaise: pack.pricePaise * at(quantities, index),
    }))
    .filter((line) => line.quantity > 0)
    .sort((a, b) => b.size - a.size);
  const supplied = best * step;
  return {
    required,
    supplied,
    surplus: supplied - required,
    totalPaise: at(cost, best),
    packCount: at(count, best),
    lines,
  };
}
