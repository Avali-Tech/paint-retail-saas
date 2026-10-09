import type { PackOption } from './pack-mix.js';

/** What the estimator needs of a pack size (a product variant) on sale. */
export interface VariantForSale {
  readonly id: string;
  readonly packSize: number;
  /** ml, l, g, kg, piece… */
  readonly unit: string;
  readonly sellingPricePaise: number | null;
  readonly mrpPaise: number | null;
  readonly isActive: boolean;
}

/** Whole units packs are bought in: mL for paint and primer, g for putty. */
export type PackMeasure = 'volume' | 'weight';

const PER_UNIT: Readonly<Record<PackMeasure, Readonly<Record<string, number>>>> = {
  volume: { ml: 1, l: 1000 },
  weight: { g: 1, kg: 1000 },
};

/**
 * The active, priced packs of a product in mL or g, the selling price before
 * the MRP. Packs in another measure (pieces, a litre of putty) are left out.
 */
export function packsOf(variants: readonly VariantForSale[], measure: PackMeasure): PackOption[] {
  return variants.flatMap((variant) => {
    const factor = PER_UNIT[measure][variant.unit] ?? 0;
    const size = Math.round(variant.packSize * factor);
    const pricePaise = variant.sellingPricePaise ?? variant.mrpPaise;
    return variant.isActive && size > 0 && pricePaise !== null
      ? [{ variantId: variant.id, size, pricePaise }]
      : [];
  });
}
