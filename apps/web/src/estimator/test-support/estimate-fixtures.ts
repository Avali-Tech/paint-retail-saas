import type { EstimateProductRef, EstimateView } from '@paint/shared';
import { product, variant } from '../../test-support/inventory-fixtures.js';
import type { PaintProduct } from '../estimator-api.js';

// Paint products and estimates as round 5a's API answers them, for component tests.

const paint = (
  id: string,
  name: string,
  coverageSqftPerLitre: number | null,
  packs: [string, number, number][],
  type: PaintProduct['type'] = 'interior_paint',
  unit: 'l' | 'kg' = 'l',
): PaintProduct => ({
  ...product({
    id,
    name,
    type,
    variants: packs.map(([sku, packSize, sellingPricePaise]) =>
      variant({ id: `v-${sku}`, sku, packSize, unit, sellingPricePaise, barcodes: [] }),
    ),
  }),
  coverageSqftPerLitre,
  defaultCoats: 2,
  isTintable: type === 'interior_paint',
});

/** Good: Tractor Emulsion, 120 sq ft/L, 20 / 10 / 4 / 1 l. */
export const TRACTOR = paint('product-tractor', 'Tractor Emulsion', 120, [
  ['TRC-20L', 20, 4_000_00],
  ['TRC-10L', 10, 2_100_00],
  ['TRC-4L', 4, 900_00],
  ['TRC-1L', 1, 250_00],
]);
/** Better: Apcolite, 130 sq ft/L. */
export const APCOLITE = paint('product-apcolite', 'Apcolite Premium', 130, [
  ['APC-10L', 10, 4_200_00],
  ['APC-4L', 4, 1_800_00],
  ['APC-1L', 1, 480_00],
]);
/** Best: Royale, 140 sq ft/L. */
export const ROYALE = paint('product-royale', 'Royale Luxury', 140, [
  ['ROY-10L', 10, 7_500_00],
  ['ROY-4L', 4, 3_100_00],
  ['ROY-1L', 1, 820_00],
]);
/** A paint whose coverage is not set yet. */
export const NO_COVERAGE = paint('product-ace', 'Ace Exterior', null, [['ACE-20L', 20, 3_000_00]]);
/** A paint with no pack priced. */
export const UNPRICED = {
  ...paint('product-old', 'Old Emulsion', 110, []),
  variants: [
    variant({ id: 'v-old', sku: 'OLD-4L', packSize: 4, sellingPricePaise: null, mrpPaise: null }),
  ],
};
export const PRIMER = paint(
  'product-primer',
  'Wall Primer',
  135,
  [['PRM-10L', 10, 1_500_00]],
  'primer',
);
export const PUTTY = paint(
  'product-putty',
  'Wall Putty',
  null,
  [['PUT-20KG', 20, 1_100_00]],
  'putty',
  'kg',
);

const ref = (paintProduct: PaintProduct): EstimateProductRef => ({
  id: paintProduct.id,
  name: paintProduct.name,
  brandName: paintProduct.brand.name,
  coverageSqftPerLitre: paintProduct.coverageSqftPerLitre,
  defaultCoats: paintProduct.defaultCoats,
  isActive: true,
});

/** A saved draft: the hall (walls and ceiling) at Ameerpet for Apex Builders, good and best chosen. */
export const ESTIMATE: EstimateView = {
  id: 'estimate-1',
  number: 'ES-000007',
  status: 'draft',
  storeId: 'store-amp',
  party: { id: 'party-1', name: 'Apex Builders', phone: null },
  project: null,
  title: 'Reddy residence',
  wastageBps: 500,
  note: null,
  totalNetAreaSqft: 651,
  surfaces: [
    {
      id: 's1',
      position: 1,
      room: 'Hall',
      kind: 'interior_wall',
      areaSqft: null,
      lengthFt: 52,
      heightFt: 10,
      openingsSqft: 37,
      condition: 'repaint',
      coats: null,
      primer: false,
      putty: false,
      grossAreaSqft: 520,
      netAreaSqft: 483,
    },
    {
      id: 's2',
      position: 2,
      room: 'Hall',
      kind: 'ceiling',
      areaSqft: null,
      lengthFt: 14,
      heightFt: 12,
      openingsSqft: 0,
      condition: 'repaint',
      coats: null,
      primer: false,
      putty: false,
      grossAreaSqft: 168,
      netAreaSqft: 168,
    },
  ],
  options: [
    {
      id: 'o1',
      tier: 'good',
      product: ref(TRACTOR),
      primerProduct: ref(PRIMER),
      puttyProduct: ref(PUTTY),
      result: null,
    },
    {
      id: 'o3',
      tier: 'best',
      product: ref(ROYALE),
      primerProduct: ref(PRIMER),
      puttyProduct: ref(PUTTY),
      result: null,
    },
  ],
  quotationId: null,
  quotationNumber: null,
  convertedTier: null,
  convertedAt: null,
  createdByMemberId: 'member-1',
  createdAt: '2026-10-08T05:00:00.000Z',
  updatedAt: '2026-10-08T05:00:00.000Z',
};

export const PAINT_PRODUCTS = [TRACTOR, APCOLITE, ROYALE, NO_COVERAGE, UNPRICED, PRIMER, PUTTY];
