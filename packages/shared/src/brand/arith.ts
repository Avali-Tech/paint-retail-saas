/**
 * Exact integer helpers for the brand engines. Every product of money and a
 * rate is taken in BigInt and divided once, with the rounding named at the call.
 */

/** A rate of 100 % in basis points. */
export const BPS = 10_000n;
/** Millilitres per litre. */
export const ML_PER_LITRE = 1_000n;
/** Days in a year, for annual rates (cost of money, holding cost). */
export const DAYS_PER_YEAR = 365n;

/** Throws unless `value` is a safe whole number (of paise, millilitres, units or days). */
export function assertWhole(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${what} must be a safe whole number, got ${String(value)}`);
  }
}

/** Throws unless `value` is a safe whole number of zero or more. */
export function assertNonNegative(value: number, what: string): void {
  assertWhole(value, what);
  if (value < 0) throw new RangeError(`${what} must not be negative, got ${String(value)}`);
}

/** Throws unless `value` is a safe whole number above zero. */
export function assertPositive(value: number, what: string): void {
  assertWhole(value, what);
  if (value <= 0) throw new RangeError(`${what} must be above zero, got ${String(value)}`);
}

function checkDenominator(denominator: bigint): void {
  if (denominator <= 0n) throw new RangeError('Denominator must be above zero');
}

/** numerator ÷ denominator rounded toward −∞ (denominator above zero). */
export function divFloor(numerator: bigint, denominator: bigint): bigint {
  checkDenominator(denominator);
  const quotient = numerator / denominator;
  return numerator % denominator < 0n ? quotient - 1n : quotient;
}

/** numerator ÷ denominator rounded toward +∞ (denominator above zero). */
export function divCeil(numerator: bigint, denominator: bigint): bigint {
  return -divFloor(-numerator, denominator);
}

/** numerator ÷ denominator to the nearest whole, an exact half to the even one (banker's). */
export function divHalfEven(numerator: bigint, denominator: bigint): bigint {
  const floor = divFloor(numerator, denominator);
  const twiceRemainder = 2n * (numerator - floor * denominator);
  if (twiceRemainder > denominator) return floor + 1n;
  if (twiceRemainder < denominator) return floor;
  return floor % 2n === 0n ? floor : floor + 1n;
}

/** Back to a number, throwing if the result left the safe integer range. */
export function toSafe(value: bigint, what: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${what} ${String(value)} is too large`);
  }
  return result;
}

/** The larger of two bigints. */
export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** The smaller of two bigints. */
export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
