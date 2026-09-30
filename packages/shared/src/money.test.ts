import { describe, expect, it } from 'vitest';
import { assertPaise, formatINR, paiseToRupees, rupeesToPaise, sumPaise } from './index.js';

describe('assertPaise', () => {
  it.each([0, 1, -1, 123_450, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])(
    'accepts %s',
    (value) => {
      expect(() => {
        assertPaise(value);
      }).not.toThrow();
    },
  );

  it.each([0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s',
    (value) => {
      expect(() => {
        assertPaise(value);
      }).toThrow(RangeError);
    },
  );
});

describe('rupeesToPaise', () => {
  it.each([
    ['0', 0],
    ['1', 100],
    ['1.5', 150],
    ['1.05', 105],
    ['1234.50', 123_450],
    ['8,50,000', 85_000_000],
    ['  99.99  ', 9999],
    ['-250.75', -25_075],
    ['-0', 0],
    ['-0.00', 0],
  ])('parses "%s" as %d paise', (input, expected) => {
    expect(rupeesToPaise(input)).toBe(expected);
  });

  it('never returns negative zero', () => {
    expect(Object.is(rupeesToPaise('-0'), 0)).toBe(true);
  });

  it.each(['', 'abc', '1.234', '1.', '.5', '₹100', '1e3', '--1', '12-3'])(
    'rejects "%s"',
    (input) => {
      expect(() => rupeesToPaise(input)).toThrow(TypeError);
    },
  );

  it('rejects amounts beyond the safe integer range', () => {
    expect(() => rupeesToPaise('999999999999999999')).toThrow(RangeError);
  });
});

describe('paiseToRupees', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [150, '1.50'],
    [123_450, '1234.50'],
    [-25_075, '-250.75'],
    [-5, '-0.05'],
  ])('formats %d paise as "%s"', (paise, expected) => {
    expect(paiseToRupees(paise)).toBe(expected);
  });

  it('rejects fractional paise', () => {
    expect(() => paiseToRupees(1.5)).toThrow(RangeError);
  });

  it('round-trips with rupeesToPaise', () => {
    for (const paise of [0, 1, 99, 100, 123_456_789, -42]) {
      expect(rupeesToPaise(paiseToRupees(paise))).toBe(paise);
    }
  });
});

describe('formatINR', () => {
  it.each([
    [0, '₹0.00'],
    [123_450, '₹1,234.50'],
    [85_000_000, '₹8,50,000.00'],
    [1_000_000_000, '₹1,00,00,000.00'],
    [-25_075, '-₹250.75'],
  ])('formats %d paise as %s', (paise, expected) => {
    expect(formatINR(paise)).toBe(expected);
  });

  it('keeps every paisa for very large amounts', () => {
    expect(formatINR(Number.MAX_SAFE_INTEGER)).toBe('₹9,00,71,99,25,47,409.91');
  });

  it('rejects fractional paise', () => {
    expect(() => formatINR(0.1)).toThrow(RangeError);
  });
});

describe('sumPaise', () => {
  it('returns 0 for no amounts', () => {
    expect(sumPaise([])).toBe(0);
  });

  it('adds amounts exactly where floating-point rupees would drift', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumPaise([rupeesToPaise('0.10'), rupeesToPaise('0.20')])).toBe(30);
  });

  it('handles refunds and credit notes as negative amounts', () => {
    expect(sumPaise([10_000, -2_500, 750])).toBe(8_250);
  });

  it('rejects an invalid amount', () => {
    expect(() => sumPaise([100, 0.5])).toThrow(RangeError);
  });

  it('rejects a total beyond the safe integer range', () => {
    expect(() => sumPaise([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
  });
});
