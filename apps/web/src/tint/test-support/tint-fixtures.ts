import type { LineTintRequest, LineTintView, TintRecordView } from '@paint/shared';
import type { Product } from '../../api/catalog.js';
import { product, variant } from '../../test-support/inventory-fixtures.js';

// Tint data for component tests (round 5a's shapes).

/** A pastel base, ₹2,000 a 4 l pack, its packs tinted at the counter (`isTintable`). */
export const PASTEL: Product = {
  ...product({
    id: 'product-pastel',
    name: 'Apex Pastel Base',
    variants: [
      variant({
        id: 'v-pastel-4',
        sku: 'APB-4L',
        packSize: 4,
        sellingPricePaise: 200_000,
        barcodes: ['8901000000024'],
      }),
    ],
  }),
  // Round 5a's paint fields, which this app's Product type does not list yet.
  ...{ coverageSqftPerLitre: 120, defaultCoats: 2, isTintable: true },
};

/** A shade billed at Ameerpet: X 132 Ivory Mist on the pastel base, ₹50 a pack to tint. */
export const tintRecord = (overrides: Partial<TintRecordView> = {}): TintRecordView => ({
  id: 'tint-1',
  lineKind: 'invoice_line',
  lineId: 'old-line',
  document: {
    kind: 'invoice',
    id: 'invoice-1',
    number: 'AMP/26-27/000042',
    status: 'issued',
    date: '2026-09-14',
  },
  store: { id: 'store-amp', name: 'Ameerpet' },
  party: { id: 'party-deccan', name: 'Deccan Contractors', phone: '+919876543210' },
  project: null,
  brand: { id: 'brand-asian', name: 'Asian Paints' },
  shadeCode: 'X 132',
  shadeName: 'Ivory Mist',
  baseVariant: {
    id: 'v-pastel-4',
    productId: 'product-pastel',
    sku: 'APB-4L',
    description: 'Apex Pastel Base 4 l',
    isActive: true,
  },
  packQuantity: 2,
  colorantCostPaise: 3_000,
  tintChargePaise: 5_000,
  machine: 'Counter 1',
  formula: [
    { colorant: 'XY', amount: 12.5, unit: 'ml' },
    { colorant: 'Fast Red', amount: 3, unit: 'shot' },
  ],
  note: null,
  createdByMemberId: 'member-1',
  createdAt: '2026-09-14T10:00:00.000Z',
  ...overrides,
});

/** A line's tint as round 5a's API reads it back after it was sent with the line. */
export const lineTintView = (request: LineTintRequest): LineTintView => ({
  id: `tint-${request.shadeCode}`,
  brand: { id: request.brandId ?? 'brand-asian', name: 'Asian Paints' },
  shadeCode: request.shadeCode,
  shadeName: request.shadeName ?? null,
  packQuantity: request.packQuantity ?? 1,
  colorantCostPaise: request.colorantCostPaise ?? null,
  tintChargePaise: request.tintChargePaise ?? 0,
  machine: request.machine ?? null,
  formula: request.formula ?? [],
  note: request.note ?? null,
  createdAt: '2026-10-09T10:00:00.000Z',
});
