import { describe, expect, it } from 'vitest';
import {
  assertScheme,
  lineCounts,
  slabBenefits,
  slabIndexFor,
  type BrandScheme,
  type SlabBenefit,
} from './scheme.js';
import { grn, litresScheme } from './test-support/fixtures.js';

const L = 1000; // millilitres per litre

describe('assertScheme', () => {
  it('accepts a well-formed scheme', () => {
    expect(() => {
      assertScheme(litresScheme({ settlementDays: 30 }));
    }).not.toThrow();
  });

  it('refuses a period that ends before it starts', () => {
    expect(() => {
      assertScheme(litresScheme({ endsOn: '2026-06-30' }));
    }).toThrow('Scheme scheme-1 ends before it starts');
    expect(() => {
      assertScheme(litresScheme({ endsOn: '2026-02-30' }));
    }).toThrow('Invalid date');
  });

  it('refuses an unknown measure or mode', () => {
    expect(() => {
      assertScheme(litresScheme({ measure: 'kg' as never }));
    }).toThrow('unknown measure or mode');
    expect(() => {
      assertScheme(litresScheme({ mode: 'stepped' as never }));
    }).toThrow('unknown measure or mode');
  });

  it('needs slabs with rising, positive targets', () => {
    expect(() => {
      assertScheme(litresScheme({ slabs: [] }));
    }).toThrow('has no slabs');
    expect(() => {
      assertScheme(litresScheme({ slabs: [{ id: 'a', target: 0, benefits: [] }] }));
    }).toThrow('Slab target must be above zero');
    expect(() => {
      assertScheme(
        litresScheme({
          slabs: [
            { id: 'a', target: 10, benefits: [] },
            { id: 'b', target: 10, benefits: [] },
          ],
        }),
      );
    }).toThrow('slab targets must rise');
  });

  it('refuses negative settlement days', () => {
    expect(() => {
      assertScheme(litresScheme({ settlementDays: -1 }));
    }).toThrow('Settlement days must not be negative');
  });

  const withBenefit = (benefit: SlabBenefit, overrides: Partial<BrandScheme> = {}) =>
    litresScheme({ slabs: [{ id: 'a', target: 10, benefits: [benefit] }], ...overrides });

  it('checks every benefit is whole and not negative', () => {
    expect(() => {
      assertScheme(withBenefit({ kind: 'rebate', basisPoints: -1 }));
    }).toThrow('Rebate basis points');
    expect(() => {
      assertScheme(withBenefit({ kind: 'per_litre', paisePerLitre: 1.5 }));
    }).toThrow('Paise per litre');
    expect(() => {
      assertScheme(
        withBenefit({ kind: 'free_goods', variantId: 'v', units: -1, perMillilitres: null }),
      );
    }).toThrow('Free units');
    expect(() => {
      assertScheme(
        withBenefit({ kind: 'free_goods', variantId: 'v', units: 1, perMillilitres: 0 }),
      );
    }).toThrow('Free goods per millilitres');
    expect(() => {
      assertScheme(withBenefit({ kind: 'points', label: 'gift', points: -5 }));
    }).toThrow('Points');
    expect(() => {
      assertScheme(withBenefit({ kind: 'voucher' } as never));
    }).toThrow('Unknown slab benefit');
  });

  it('lets a retro scheme mix bases but not an incremental one', () => {
    const rebate: SlabBenefit = { kind: 'rebate', basisPoints: 100 };
    expect(() => {
      assertScheme(withBenefit(rebate));
    }).not.toThrow();
    expect(() => {
      assertScheme(withBenefit(rebate, { mode: 'incremental' }));
    }).toThrow('An incremental litres scheme cannot give a rebate benefit; make it retro');
    expect(() => {
      assertScheme(
        withBenefit(
          { kind: 'per_litre', paisePerLitre: 1 },
          { mode: 'incremental', measure: 'value' },
        ),
      );
    }).toThrow('An incremental value scheme cannot give a per_litre benefit');
    expect(() => {
      assertScheme(
        withBenefit(
          { kind: 'free_goods', variantId: 'v', units: 1, perMillilitres: 1000 },
          { mode: 'incremental', measure: 'value' },
        ),
      );
    }).toThrow('cannot give a free_goods benefit');
    // Fixed benefits have no basis, so any scheme may give them.
    expect(() => {
      assertScheme(
        withBenefit(
          { kind: 'free_goods', variantId: 'v', units: 1, perMillilitres: null },
          { mode: 'incremental', measure: 'value' },
        ),
      );
    }).not.toThrow();
    expect(() => {
      assertScheme(
        withBenefit({ kind: 'points', label: 'gift', points: 1 }, { mode: 'incremental' }),
      );
    }).not.toThrow();
  });
});

describe('lineCounts', () => {
  const asOf = '2026-09-30';

  it('counts the brand’s lines in the period up to the as-of day', () => {
    const scheme = litresScheme();
    expect(lineCounts(scheme, grn(), asOf)).toBe(true);
    expect(lineCounts(scheme, grn({ receivedOn: '2026-07-01' }), asOf)).toBe(true);
    expect(lineCounts(scheme, grn({ receivedOn: '2026-09-30' }), asOf)).toBe(true);
    expect(lineCounts(scheme, grn({ receivedOn: '2026-06-30' }), asOf)).toBe(false);
    expect(lineCounts(scheme, grn({ receivedOn: '2026-10-01' }), '2026-12-31')).toBe(false);
    expect(lineCounts(scheme, grn({ receivedOn: '2026-08-02' }), '2026-08-01')).toBe(false);
    expect(lineCounts(scheme, grn({ brandId: 'brand-b' }), asOf)).toBe(false);
  });

  it('keeps to the products or categories named', () => {
    const scheme = litresScheme({ productIds: ['p-2'], categoryIds: ['c-enamel'] });
    expect(lineCounts(scheme, grn(), asOf)).toBe(false);
    expect(lineCounts(scheme, grn({ productId: 'p-2' }), asOf)).toBe(true);
    expect(lineCounts(scheme, grn({ categoryId: 'c-enamel' }), asOf)).toBe(true);
    expect(lineCounts(scheme, grn({ categoryId: null }), asOf)).toBe(false);
  });
});

describe('slabIndexFor', () => {
  it('finds the highest slab reached, a target counting as reached', () => {
    const scheme = litresScheme();
    expect(slabIndexFor(scheme, 0)).toBe(-1);
    expect(slabIndexFor(scheme, 1000 * L - 1)).toBe(-1);
    expect(slabIndexFor(scheme, 1000 * L)).toBe(0);
    expect(slabIndexFor(scheme, 4999 * L)).toBe(1);
    expect(slabIndexFor(scheme, 9000 * L)).toBe(2);
  });
});

describe('slabBenefits', () => {
  it('gives nothing below the first slab', () => {
    expect(slabBenefits(litresScheme(), 5_00_000_00, 999 * L)).toEqual({
      rebatePaise: 0,
      perLitrePaise: 0,
      creditPaise: 0,
      freeGoods: [],
      points: [],
    });
  });

  it('pays the top slab on everything in retro', () => {
    // 2,500 L at slab 2: ₹3 × 2,500 = ₹7,500.
    expect(slabBenefits(litresScheme(), 5_00_000_00, 2500 * L)).toMatchObject({
      perLitrePaise: 7_500_00,
      creditPaise: 7_500_00,
    });
  });

  it('pays each band its own slab in incremental', () => {
    // 2,000 L × ₹2 + 500 L × ₹3 = ₹5,500.
    const scheme = litresScheme({ mode: 'incremental' });
    expect(slabBenefits(scheme, 0, 2500 * L).perLitrePaise).toBe(5_500_00);
    // Only slab 1 reached: the same as retro.
    expect(slabBenefits(scheme, 0, 1500 * L).perLitrePaise).toBe(3_000_00);
    expect(slabBenefits(litresScheme(), 0, 1500 * L).perLitrePaise).toBe(3_000_00);
    // On slab 3: 2,000 × 2 + 3,000 × 3 + 1,000 × 5 = ₹18,000, and the trip once.
    expect(slabBenefits(scheme, 0, 6000 * L)).toMatchObject({
      perLitrePaise: 18_000_00,
      points: [{ label: 'trip', points: 1 }],
    });
  });

  it('treats a negative total as nothing', () => {
    expect(slabBenefits(litresScheme(), -1, -5).creditPaise).toBe(0);
  });

  it('rounds money down once per kind', () => {
    const scheme = litresScheme({
      slabs: [{ id: 'a', target: 1, benefits: [{ kind: 'per_litre', paisePerLitre: 333 }] }],
    });
    // 333 × 1.001 L = 333.333 paise.
    expect(slabBenefits(scheme, 0, 1001).perLitrePaise).toBe(333);
    const value = litresScheme({
      measure: 'value',
      slabs: [{ id: 'a', target: 1, benefits: [{ kind: 'rebate', basisPoints: 150 }] }],
    });
    // 1.5 % of 12,345.67 = 185.18505.
    expect(slabBenefits(value, 12_345_67, 0).rebatePaise).toBe(185_18);
  });

  it('gives a retro rebate on value though the target is in litres', () => {
    const scheme = litresScheme({
      slabs: [
        { id: 'a', target: 1000 * L, benefits: [{ kind: 'rebate', basisPoints: 100 }] },
        {
          id: 'b',
          target: 2000 * L,
          benefits: [
            { kind: 'rebate', basisPoints: 200 },
            { kind: 'per_litre', paisePerLitre: 100 },
          ],
        },
      ],
    });
    // 2 % of ₹4,00,000 plus ₹1 × 2,000 L.
    expect(slabBenefits(scheme, 4_00_000_00, 2000 * L)).toMatchObject({
      rebatePaise: 8_000_00,
      perLitrePaise: 2_000_00,
      creditPaise: 10_000_00,
    });
  });

  it('gives a per-litre amount on a rupee target in retro', () => {
    const scheme = litresScheme({
      measure: 'value',
      slabs: [
        { id: 'a', target: 1_00_000_00, benefits: [{ kind: 'per_litre', paisePerLitre: 50 }] },
      ],
    });
    expect(slabBenefits(scheme, 1_00_000_00, 400 * L).perLitrePaise).toBe(200_00);
    expect(slabBenefits(scheme, 99_999_99, 400 * L).perLitrePaise).toBe(0);
  });

  it('counts free goods fixed or by ratio, and points, by name', () => {
    const scheme = litresScheme({
      slabs: [
        {
          id: 'a',
          target: 100 * L,
          benefits: [
            { kind: 'free_goods', variantId: 'v-20l', units: 1, perMillilitres: 100 * L },
            { kind: 'free_goods', variantId: 'v-1l', units: 2, perMillilitres: null },
            { kind: 'points', label: 'gift', points: 50 },
          ],
        },
        {
          id: 'b',
          target: 500 * L,
          benefits: [
            { kind: 'free_goods', variantId: 'v-20l', units: 3, perMillilitres: 200 * L },
            { kind: 'free_goods', variantId: 'v-1l', units: 2, perMillilitres: null },
            { kind: 'points', label: 'trip', points: 1 },
            { kind: 'points', label: 'gift', points: 100 },
          ],
        },
      ],
    });
    // Retro at 550 L: slab b only, 3 × ⌊550 ÷ 200⌋ = 6 of v-20l.
    expect(slabBenefits(scheme, 0, 550 * L)).toMatchObject({
      freeGoods: [
        { variantId: 'v-1l', units: 2 },
        { variantId: 'v-20l', units: 6 },
      ],
      points: [
        { label: 'gift', points: 100 },
        { label: 'trip', points: 1 },
      ],
      creditPaise: 0,
    });
    // Incremental at 550 L: band a is [0, 500) → ⌊500 ÷ 100⌋ = 5; band b is 50 L → 3 × ⌊50 ÷ 200⌋ = 0.
    expect(slabBenefits({ ...scheme, mode: 'incremental' }, 0, 550 * L)).toMatchObject({
      freeGoods: [
        { variantId: 'v-1l', units: 4 },
        { variantId: 'v-20l', units: 5 },
      ],
      points: [
        { label: 'gift', points: 150 },
        { label: 'trip', points: 1 },
      ],
    });
  });

  it('fails rather than lose precision on an absurd total', () => {
    const scheme = litresScheme({
      measure: 'value',
      slabs: [{ id: 'a', target: 1, benefits: [{ kind: 'points', label: 'x', points: 1 }] }],
    });
    expect(() => slabBenefits(scheme, Number.MAX_SAFE_INTEGER, 0)).not.toThrow();
    const rich = litresScheme({
      slabs: [
        {
          id: 'a',
          target: 1,
          benefits: [{ kind: 'per_litre', paisePerLitre: Number.MAX_SAFE_INTEGER }],
        },
      ],
    });
    expect(() => slabBenefits(rich, 0, Number.MAX_SAFE_INTEGER)).toThrow('is too large');
  });
});
