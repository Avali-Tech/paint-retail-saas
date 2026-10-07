import { GstError } from './errors.js';

/**
 * Exact integer helpers for the tax engine. Every product of money and a rate
 * or a quantity is taken in BigInt, so nothing passes through a float.
 */

/** Throws unless `value` is a whole, non-negative, safe number of paise. */
export function checkPaise(value: number, what: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GstError(
      'invalid_amount',
      `${what} must be whole non-negative paise, got ${String(value)}`,
    );
  }
  return BigInt(value);
}

/** Back to a number, throwing if the result left the safe integer range. */
export function toPaise(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new GstError('invalid_amount', `Amount ${String(value)} paise is too large`);
  }
  return result;
}

/** numerator / denominator rounded to the nearest whole, halves up (both non-negative). */
export function roundDiv(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

/**
 * Splits `amount` paise across `weights` in proportion, exactly: each share is
 * floored, then the leftover paise go one each to the largest remainders, the
 * earlier entry winning a tie. The shares always add up to `amount`.
 */
export function allocateProportionally(amount: number, weights: readonly number[]): number[] {
  const total = checkPaise(amount, 'Amount to allocate');
  const big = weights.map((weight) => checkPaise(weight, 'Weight'));
  const sum = big.reduce((acc, weight) => acc + weight, 0n);
  if (sum === 0n) {
    if (total === 0n) return weights.map(() => 0);
    throw new GstError('discount_exceeds_value', 'Cannot allocate an amount across nothing');
  }
  const shares = big.map((weight) => (total * weight) / sum);
  const order = big
    .map((weight, index) => ({ index, remainder: (total * weight) % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  // The leftover is the sum of the remainders over `sum`, so always fewer than the entries.
  const left = Number(total - shares.reduce((acc, share) => acc + share, 0n));
  const bumped = new Set(order.slice(0, left).map(({ index }) => index));
  return shares.map((share, index) => toPaise(bumped.has(index) ? share + 1n : share));
}

const QUANTITY = /^\d+(?:\.\d{1,3})?$/;

/**
 * A quantity with up to 3 decimals (litres, kilograms) as whole thousandths,
 * read from its decimal text so 0.1 is exactly 100.
 */
export function quantityToMilli(quantity: number): bigint {
  const text = String(quantity);
  if (!QUANTITY.test(text) || quantity <= 0) {
    throw new GstError(
      'invalid_quantity',
      `Quantity must be positive with at most 3 decimals, got ${text}`,
    );
  }
  const dot = text.indexOf('.');
  const decimals = dot < 0 ? 0 : text.length - dot - 1;
  const milli = BigInt(text.replace('.', '')) * 10n ** BigInt(3 - decimals);
  if (milli > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new GstError('invalid_quantity', `Quantity ${text} is too large`);
  }
  return milli;
}

/** `items[index]`, throwing instead of returning undefined for an index out of range. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new RangeError(`No entry at index ${String(index)}`);
  return item;
}
