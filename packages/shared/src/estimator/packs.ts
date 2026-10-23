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
  /** Grams per ml, set on the pack: lets a pack weighed in kg count in litres, or the other way. */
  readonly densityGPerMl: number | null;
}

/** Whole units packs are bought in: mL for paint and primer, g for putty. */
export type PackMeasure = 'volume' | 'weight';

const PER_UNIT: Readonly<Record<PackMeasure, Readonly<Record<string, number>>>> = {
  volume: { ml: 1, l: 1000 },
  weight: { g: 1, kg: 1000 },
};

/**
 * How much of `measure` one pack holds, in mL or g: as it is, or through the
 * pack's density from the other measure (a distemper sold by the kg covers
 * by the litre; ml = g ÷ density, g = ml × density). Zero when it cannot be
 * told (pieces, or no density for the other measure).
 */
export function packAmount(variant: VariantForSale, measure: PackMeasure): number {
  const own = PER_UNIT[measure][variant.unit];
  if (own !== undefined) return variant.packSize * own;
  const other = measure === 'volume' ? 'weight' : 'volume';
  const factor = PER_UNIT[other][variant.unit];
  if (factor === undefined || variant.densityGPerMl === null) return 0;
  const amount = variant.packSize * factor;
  return measure === 'volume' ? amount / variant.densityGPerMl : amount * variant.densityGPerMl;
}

/**
 * The active, priced packs of a product in mL or g, the selling price before
 * the MRP. Packs in the other measure count through their density; packs that
 * cannot be told in this measure (pieces, or no density) are left out.
 */
export function packsOf(variants: readonly VariantForSale[], measure: PackMeasure): PackOption[] {
  return variants.flatMap((variant) => {
    // Whole mL or g, rounded down: a pack is never counted as holding more than it does.
    const size = Math.floor(packAmount(variant, measure) + 1e-9);
    const pricePaise = variant.sellingPricePaise ?? variant.mrpPaise;
    return variant.isActive && size > 0 && pricePaise !== null
      ? [{ variantId: variant.id, size, pricePaise }]
      : [];
  });
}
