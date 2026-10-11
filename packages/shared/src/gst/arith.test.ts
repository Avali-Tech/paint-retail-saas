import { describe, expect, it } from 'vitest';
import { allocateProportionally } from '../index.js';
import { at, checkPaise, quantityToMilli, roundDiv, toPaise } from './arith.js';

describe('checkPaise and toPaise', () => {
  it('accepts whole non-negative paise as BigInt', () => {
    expect(checkPaise(0, 'x')).toBe(0n);
    expect(checkPaise(123, 'x')).toBe(123n);
  });

  it('refuses fractions, negatives and unsafe numbers', () => {
    expect(() => checkPaise(1.5, 'Price')).toThrow(
      'Price must be whole non-negative paise, got 1.5',
    );
    expect(() => checkPaise(-1, 'Price')).toThrow(
      expect.objectContaining({ code: 'invalid_amount' }),
    );
    expect(() => checkPaise(2 ** 53, 'Price')).toThrow('Price must be whole');
  });

  it('converts back, refusing a result beyond the safe range', () => {
    expect(toPaise(42n)).toBe(42);
    expect(() => toPaise(2n ** 53n)).toThrow('Amount 9007199254740992 paise is too large');
  });
});

describe('roundDiv', () => {
  it('rounds half up', () => {
    expect([roundDiv(4n, 10n), roundDiv(5n, 10n), roundDiv(15n, 10n), roundDiv(14n, 10n)]).toEqual([
      0n,
      1n,
      2n,
      1n,
    ]);
    expect(roundDiv(0n, 7n)).toBe(0n);
  });
});

describe('allocateProportionally', () => {
  it('splits exactly, the leftover going to the largest remainders', () => {
    expect(allocateProportionally(10_000, [10_000, 20_000, 30_000])).toEqual([1667, 3333, 5000]);
    expect(allocateProportionally(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateProportionally(2, [1, 1, 1])).toEqual([1, 1, 0]);
  });

  it('prefers a larger remainder over an earlier line', () => {
    // 5 × 1/4 = 1.25, 5 × 3/4 = 3.75: the paisa goes to the second line.
    expect(allocateProportionally(5, [1, 3])).toEqual([1, 4]);
  });

  it('allocates nothing across zero weights, and refuses something', () => {
    expect(allocateProportionally(0, [0, 0])).toEqual([0, 0]);
    expect(allocateProportionally(0, [])).toEqual([]);
    expect(() => allocateProportionally(1, [0])).toThrow(
      expect.objectContaining({ code: 'discount_exceeds_value' }),
    );
  });

  it('gives zero-weight entries nothing', () => {
    expect(allocateProportionally(7, [0, 3, 0, 4])).toEqual([0, 3, 0, 4]);
  });
});

describe('quantityToMilli', () => {
  it('reads up to 3 decimals exactly', () => {
    expect(quantityToMilli(1)).toBe(1000n);
    expect(quantityToMilli(0.1)).toBe(100n);
    expect(quantityToMilli(2.5)).toBe(2500n);
    expect(quantityToMilli(1.005)).toBe(1005n);
  });

  it('refuses zero, negatives, too many decimals and exponents', () => {
    for (const bad of [0, -1, 1.0005, 1e-7, 1e21, Number.NaN]) {
      expect(() => quantityToMilli(bad)).toThrow(
        expect.objectContaining({ code: 'invalid_quantity' }),
      );
    }
  });

  it('refuses a quantity too large to count in thousandths', () => {
    expect(() => quantityToMilli(1e19)).toThrow('Quantity 10000000000000000000 is too large');
  });
});

describe('at', () => {
  it('returns the entry or throws out of range', () => {
    expect(at(['a', 'b'], 1)).toBe('b');
    expect(() => at(['a'], 1)).toThrow('No entry at index 1');
  });
});
