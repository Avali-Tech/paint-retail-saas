import { describe, expect, it } from 'vitest';
import { discountAmount, priceLine, taxOnAmount, type AppliedRate } from '../index.js';

const eighteen: AppliedRate = { nature: 'taxable', rateBasisPoints: 1800, cessBasisPoints: 0 };

describe('discountAmount', () => {
  it('is zero without a discount', () => {
    expect(discountAmount(10_000, null)).toBe(0);
  });

  it('rounds a percentage half up to the paisa', () => {
    expect(discountAmount(10_000, { kind: 'percent', basisPoints: 1000 })).toBe(1000);
    // 12.5% of ₹0.99 = 12.375 paise → 12; 15% of ₹0.99 = 14.85 → 15; 50% of 5 paise = 2.5 → 3.
    expect(discountAmount(99, { kind: 'percent', basisPoints: 1250 })).toBe(12);
    expect(discountAmount(99, { kind: 'percent', basisPoints: 1500 })).toBe(15);
    expect(discountAmount(5, { kind: 'percent', basisPoints: 5000 })).toBe(3);
    expect(discountAmount(777, { kind: 'percent', basisPoints: 10_000 })).toBe(777);
    expect(discountAmount(777, { kind: 'percent', basisPoints: 0 })).toBe(0);
  });

  it('refuses a percentage outside 0–100% or not whole basis points', () => {
    for (const basisPoints of [-1, 10_001, 12.5]) {
      expect(() => discountAmount(100, { kind: 'percent', basisPoints })).toThrow(
        expect.objectContaining({ code: 'invalid_discount' }),
      );
    }
  });

  it('takes an amount as given, up to the whole base', () => {
    expect(discountAmount(10_000, { kind: 'amount', paise: 10_000 })).toBe(10_000);
    expect(() => discountAmount(10_000, { kind: 'amount', paise: 10_001 })).toThrow(
      'Discount 10001 exceeds 10000 paise',
    );
    expect(() => discountAmount(10_000, { kind: 'amount', paise: -1 })).toThrow(
      expect.objectContaining({ code: 'invalid_amount' }),
    );
  });
});

describe('priceLine', () => {
  it('multiplies quantity by price and takes off the line discount', () => {
    expect(
      priceLine({
        categoryCode: 'paint',
        quantity: 4,
        unitPricePaise: 2_499_00,
        discount: { kind: 'amount', paise: 500_00 },
      }),
    ).toEqual({
      quantityMilli: 4000,
      grossPaise: 9_996_00,
      lineDiscountPaise: 500_00,
      netPaise: 9_496_00,
    });
  });

  it('rounds a fractional quantity’s gross half up', () => {
    // 0.333 × ₹1.50 = 49.95 paise → 50; 1.001 × 50 paise = 50.05 → 50.
    expect(
      priceLine({ categoryCode: 'x', quantity: 0.333, unitPricePaise: 150, discount: null })
        .grossPaise,
    ).toBe(50);
    expect(
      priceLine({ categoryCode: 'x', quantity: 1.001, unitPricePaise: 50, discount: null })
        .grossPaise,
    ).toBe(50);
  });

  it('refuses a bad price or quantity, or a gross beyond the safe range', () => {
    expect(() =>
      priceLine({ categoryCode: 'x', quantity: 1, unitPricePaise: 1.5, discount: null }),
    ).toThrow('Unit price must be whole');
    expect(() =>
      priceLine({ categoryCode: 'x', quantity: 0, unitPricePaise: 1, discount: null }),
    ).toThrow(expect.objectContaining({ code: 'invalid_quantity' }));
    expect(() =>
      priceLine({
        categoryCode: 'x',
        quantity: 1_000_000,
        unitPricePaise: 2 ** 52,
        discount: null,
      }),
    ).toThrow('paise is too large');
  });
});

describe('taxOnAmount', () => {
  it('exclusive intra-state: two equal halves', () => {
    expect(taxOnAmount(1025, eighteen, 'intra_state', false)).toEqual({
      taxablePaise: 1025,
      cgstPaise: 92,
      sgstPaise: 92,
      igstPaise: 0,
      cessPaise: 0,
    });
  });

  it('exclusive inter-state: IGST at the full rate, rounded once', () => {
    expect(taxOnAmount(1025, eighteen, 'inter_state', false)).toEqual({
      taxablePaise: 1025,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 185,
      cessPaise: 0,
    });
  });

  it('inclusive with cess: the divisor includes the cess; the price is kept', () => {
    const withCess: AppliedRate = { ...eighteen, cessBasisPoints: 1200 };
    // ₹130 × 100/130 = ₹100; IGST ₹18, cess ₹12.
    expect(taxOnAmount(130_00, withCess, 'inter_state', true)).toEqual({
      taxablePaise: 100_00,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 18_00,
      cessPaise: 12_00,
    });
  });

  it('a zero rate taxes nothing either way', () => {
    const nil: AppliedRate = { nature: 'nil_rated', rateBasisPoints: 0, cessBasisPoints: 0 };
    expect(taxOnAmount(999, nil, 'intra_state', true)).toMatchObject({
      taxablePaise: 999,
      cgstPaise: 0,
    });
  });

  it('refuses an amount too small to carry its rounded tax', () => {
    // 1 paisa at 100%: taxable rounds to 1, each half of 0.5 rounds up to 1, tax 2 > 1.
    const full: AppliedRate = { nature: 'taxable', rateBasisPoints: 10_000, cessBasisPoints: 0 };
    expect(() => taxOnAmount(1, full, 'intra_state', true)).toThrow(
      '1 paise is too small to carry its tax',
    );
  });
});
