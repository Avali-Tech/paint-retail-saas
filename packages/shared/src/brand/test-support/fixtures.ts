import { DEFAULT_SLAB_MODE, type BrandScheme, type SchemeGrnLine } from '../scheme.js';

// Shared fixtures for the brand engine tests.

const L = 1000; // millilitres per litre

/** A litres scheme: 1,000 L ₹2/L, 2,000 L ₹3/L, 5,000 L ₹5/L and a trip. */
export function litresScheme(overrides: Partial<BrandScheme> = {}): BrandScheme {
  return {
    id: 'scheme-1',
    brandId: 'brand-a',
    startsOn: '2026-07-01',
    endsOn: '2026-09-30',
    measure: 'litres',
    mode: DEFAULT_SLAB_MODE,
    productIds: [],
    categoryIds: [],
    slabs: [
      { id: 's1', target: 1000 * L, benefits: [{ kind: 'per_litre', paisePerLitre: 200 }] },
      { id: 's2', target: 2000 * L, benefits: [{ kind: 'per_litre', paisePerLitre: 300 }] },
      {
        id: 's3',
        target: 5000 * L,
        benefits: [
          { kind: 'per_litre', paisePerLitre: 500 },
          { kind: 'points', label: 'trip', points: 1 },
        ],
      },
    ],
    settlementDays: null,
    ...overrides,
  };
}

export function grn(overrides: Partial<SchemeGrnLine> = {}): SchemeGrnLine {
  return {
    id: 'grn-1',
    brandId: 'brand-a',
    productId: 'p-1',
    categoryId: 'c-emulsion',
    receivedOn: '2026-08-01',
    valuePaise: 1_00_000_00,
    millilitres: 100 * L,
    freeMillilitres: 0,
    ...overrides,
  };
}
