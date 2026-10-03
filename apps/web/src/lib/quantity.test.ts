import { describe, expect, it } from 'vitest';
import { parsePositiveQuantity, parseQuantity } from './quantity.js';

describe('stock quantities', () => {
  it('reads quantities with at most three decimals', () => {
    expect(parseQuantity(' 1.125 ')).toBe(1.125);
    expect(parseQuantity('-3')).toBe(-3);
    expect(parseQuantity('1.2345')).toBeNull();
    expect(parseQuantity('')).toBeNull();
  });

  it('reads quantities that must be above zero', () => {
    expect(parsePositiveQuantity('2')).toBe(2);
    expect(parsePositiveQuantity('0')).toBeNull();
    expect(parsePositiveQuantity('x')).toBeNull();
  });
});
