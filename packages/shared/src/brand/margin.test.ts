import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COST_OF_MONEY_BPS,
  brandMargins,
  marginBps,
  paiseDays,
  sumMargins,
  type BrandSchemeMoney,
  type MarginRow,
} from './margin.js';

function row(overrides: Partial<MarginRow> = {}): MarginRow {
  return {
    brandId: 'brand-a',
    productId: 'p1',
    storeId: 's1',
    invoicedPaise: 0,
    creditNotePaise: 0,
    costOfSalesPaise: 0,
    costReturnedPaise: 0,
    creditPaiseDays: 0,
    loyaltyPaise: 0,
    painterPointsPaise: 0,
    ...overrides,
  };
}

const rows: MarginRow[] = [
  row({
    invoicedPaise: 1_00_000_00,
    creditNotePaise: 10_000_00,
    costOfSalesPaise: 70_000_00,
    costReturnedPaise: 7_000_00,
    // ₹1,00,000 unpaid for 30 days.
    creditPaiseDays: 1_00_000_00 * 30,
    loyaltyPaise: 500_00,
    painterPointsPaise: 1_000_00,
  }),
  row({ productId: 'p2', invoicedPaise: 50_000_00, costOfSalesPaise: 30_000_00 }),
  row({ storeId: 's2', invoicedPaise: 20_000_00, costOfSalesPaise: 14_000_00 }),
  row({
    brandId: 'brand-b',
    productId: 'p3',
    invoicedPaise: 10_000_00,
    costOfSalesPaise: 9_000_00,
  }),
];

const schemes: BrandSchemeMoney[] = [
  { brandId: 'brand-a', receivedPaise: 3_000_00, expectedPaise: 2_000_00 },
  { brandId: 'brand-a', receivedPaise: 2_000_00, expectedPaise: 0 },
  // Scheme money on a brand with no sales in the period.
  { brandId: 'brand-c', receivedPaise: 1_000_00, expectedPaise: 0 },
];

const byBrand = { groupBy: [], costOfMoneyBps: DEFAULT_COST_OF_MONEY_BPS } as const;

describe('brandMargins', () => {
  it('works out each brand’s contribution', () => {
    const [a, b, c] = brandMargins(rows, schemes, byBrand);
    // Credit cost: 30,00,00,000 paise-days × 12 % ÷ 365 = 98,630.14 paise.
    // 53,000 gross + 7,000 schemes − 986.30 credit − 1,500 loyalty = ₹57,513.70.
    expect(a).toEqual({
      brandId: 'brand-a',
      productId: null,
      storeId: null,
      invoicedPaise: 1_70_000_00,
      creditNotePaise: 10_000_00,
      netSalesPaise: 1_60_000_00,
      costPaise: 1_07_000_00,
      grossMarginPaise: 53_000_00,
      schemeReceivedPaise: 5_000_00,
      schemeExpectedPaise: 2_000_00,
      creditCostPaise: 986_30,
      loyaltyPaise: 500_00,
      painterPointsPaise: 1_000_00,
      contributionPaise: 57_513_70,
      // 35.946 %.
      marginBps: 3595,
    });
    expect(b).toMatchObject({ brandId: 'brand-b', contributionPaise: 1_000_00, marginBps: 1000 });
    expect(c).toMatchObject({
      brandId: 'brand-c',
      productId: null,
      netSalesPaise: 0,
      schemeReceivedPaise: 1_000_00,
      contributionPaise: 1_000_00,
      marginBps: null,
    });
  });

  it('splits by product and store and spreads scheme money by cost', () => {
    const slices = brandMargins(rows, schemes, { ...byBrand, groupBy: ['product', 'store'] });
    expect(slices.map((s) => [s.brandId, s.productId, s.storeId])).toEqual([
      ['brand-a', 'p1', 's1'],
      ['brand-a', 'p1', 's2'],
      ['brand-a', 'p2', 's1'],
      ['brand-b', 'p3', 's1'],
      ['brand-c', null, null],
    ]);
    // ₹5,000 over costs 63,000 / 14,000 / 30,000: 2,943.93 / 654.21 / 1,401.87.
    expect(slices.slice(0, 3).map((s) => s.schemeReceivedPaise)).toEqual([
      2_943_92, 654_21, 1_401_87,
    ]);
    const brandA = sumMargins(slices.slice(0, 3));
    const [whole] = brandMargins(rows, schemes, byBrand);
    expect(brandA).toEqual({
      ...whole,
      brandId: undefined,
      productId: undefined,
      storeId: undefined,
    });
  });

  it('splits by store alone', () => {
    const slices = brandMargins(rows, [], { ...byBrand, groupBy: ['store'] });
    expect(slices.map((s) => [s.brandId, s.productId, s.storeId, s.netSalesPaise])).toEqual([
      ['brand-a', null, 's1', 1_40_000_00],
      ['brand-a', null, 's2', 20_000_00],
      ['brand-b', null, 's1', 10_000_00],
    ]);
  });

  it('spreads by net sales without cost, else evenly', () => {
    const bySales = brandMargins(
      [
        row({ storeId: 's1', invoicedPaise: 300 }),
        row({ storeId: 's2', invoicedPaise: 100, costReturnedPaise: 50 }),
      ],
      [{ brandId: 'brand-a', receivedPaise: 100, expectedPaise: 0 }],
      { ...byBrand, groupBy: ['store'] },
    );
    expect(bySales.map((s) => s.schemeReceivedPaise)).toEqual([75, 25]);
    const evenly = brandMargins(
      [row({ storeId: 's1' }), row({ storeId: 's2' })],
      [{ brandId: 'brand-a', receivedPaise: 3, expectedPaise: 0 }],
      { ...byBrand, groupBy: ['store'] },
    );
    expect(evenly.map((s) => s.schemeReceivedPaise)).toEqual([2, 1]);
  });

  it('refuses negative or fractional figures', () => {
    const fields: (keyof MarginRow)[] = [
      'invoicedPaise',
      'creditNotePaise',
      'costOfSalesPaise',
      'costReturnedPaise',
      'creditPaiseDays',
      'loyaltyPaise',
      'painterPointsPaise',
    ];
    for (const field of fields) {
      expect(() => brandMargins([row({ [field]: -1 })], [], byBrand)).toThrow(RangeError);
    }
    expect(() =>
      brandMargins([], [{ brandId: 'x', receivedPaise: -1, expectedPaise: 0 }], byBrand),
    ).toThrow('Scheme received');
    expect(() =>
      brandMargins([], [{ brandId: 'x', receivedPaise: 0, expectedPaise: 0.5 }], byBrand),
    ).toThrow('Scheme expected');
    expect(() => brandMargins([], [], { groupBy: [], costOfMoneyBps: -1 })).toThrow(
      'Cost of money',
    );
  });
});

describe('marginBps', () => {
  it('rounds half to even and needs positive sales', () => {
    expect(marginBps(1, 20_000)).toBe(0); // 0.5 bp → 0
    expect(marginBps(3, 20_000)).toBe(2); // 1.5 bp → 2
    expect(marginBps(-5_000, 10_000)).toBe(-5000);
    expect(marginBps(100, 0)).toBeNull();
    expect(marginBps(100, -10)).toBeNull();
  });
});

describe('sumMargins', () => {
  it('sums nothing to zero', () => {
    expect(sumMargins([])).toMatchObject({
      netSalesPaise: 0,
      contributionPaise: 0,
      marginBps: null,
    });
  });
});

describe('paiseDays', () => {
  it('counts amount × days owed inside the period', () => {
    expect(
      paiseDays(
        [
          // Owed 1 to 10 July: 10 days.
          { amountPaise: 100, fromOn: '2026-06-20', paidOn: '2026-07-11' },
          // Unpaid from 25 July: 7 days.
          { amountPaise: 100, fromOn: '2026-07-25', paidOn: null },
          // Paid before the period, and raised after it.
          { amountPaise: 100, fromOn: '2026-06-01', paidOn: '2026-06-30' },
          { amountPaise: 100, fromOn: '2026-08-01', paidOn: null },
          // Paid the day it was raised.
          { amountPaise: 100, fromOn: '2026-07-05', paidOn: '2026-07-05' },
        ],
        '2026-07-01',
        '2026-07-31',
      ),
    ).toBe(1700);
    expect(() =>
      paiseDays(
        [{ amountPaise: -1, fromOn: '2026-07-01', paidOn: null }],
        '2026-07-01',
        '2026-07-31',
      ),
    ).toThrow('Outstanding amount');
  });
});
