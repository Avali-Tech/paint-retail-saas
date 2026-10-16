import { describe, expect, it } from 'vitest';
import {
  assertNonNegative,
  assertPositive,
  assertWhole,
  divCeil,
  divFloor,
  divHalfEven,
  maxBig,
  minBig,
  toSafe,
} from './arith.js';

describe('brand arithmetic', () => {
  it('checks whole, non-negative and positive numbers', () => {
    expect(() => {
      assertWhole(-3, 'x');
    }).not.toThrow();
    expect(() => {
      assertWhole(1.5, 'Value');
    }).toThrow('Value must be a safe whole number, got 1.5');
    expect(() => {
      assertWhole(Number.MAX_SAFE_INTEGER + 1, 'Value');
    }).toThrow(RangeError);
    expect(() => {
      assertNonNegative(0, 'x');
    }).not.toThrow();
    expect(() => {
      assertNonNegative(-1, 'Units');
    }).toThrow('Units must not be negative, got -1');
    expect(() => {
      assertPositive(1, 'x');
    }).not.toThrow();
    expect(() => {
      assertPositive(0, 'Target');
    }).toThrow('Target must be above zero, got 0');
  });

  it('floors and ceils toward the infinities, for either sign', () => {
    expect(divFloor(7n, 2n)).toBe(3n);
    expect(divFloor(-7n, 2n)).toBe(-4n);
    expect(divFloor(-6n, 2n)).toBe(-3n);
    expect(divCeil(7n, 2n)).toBe(4n);
    expect(divCeil(-7n, 2n)).toBe(-3n);
    expect(divCeil(6n, 2n)).toBe(3n);
    expect(() => divFloor(1n, 0n)).toThrow('Denominator must be above zero');
    expect(() => divCeil(1n, -1n)).toThrow(RangeError);
  });

  it('rounds halves to even and the rest to nearest', () => {
    expect(divHalfEven(5n, 2n)).toBe(2n); // 2.5 → 2
    expect(divHalfEven(7n, 2n)).toBe(4n); // 3.5 → 4
    expect(divHalfEven(-5n, 2n)).toBe(-2n); // −2.5 → −2
    expect(divHalfEven(-7n, 2n)).toBe(-4n); // −3.5 → −4
    expect(divHalfEven(10n, 3n)).toBe(3n); // 3.33 → 3
    expect(divHalfEven(11n, 3n)).toBe(4n); // 3.67 → 4
    expect(divHalfEven(-11n, 3n)).toBe(-4n);
    expect(divHalfEven(6n, 3n)).toBe(2n);
  });

  it('converts back to a number only within the safe range', () => {
    expect(toSafe(42n, 'Total')).toBe(42);
    expect(() => toSafe(2n ** 60n, 'Total')).toThrow(`Total ${String(2n ** 60n)} is too large`);
  });

  it('picks the larger and the smaller', () => {
    expect(maxBig(1n, 2n)).toBe(2n);
    expect(maxBig(3n, 2n)).toBe(3n);
    expect(minBig(1n, 2n)).toBe(1n);
    expect(minBig(3n, 2n)).toBe(2n);
  });
});
