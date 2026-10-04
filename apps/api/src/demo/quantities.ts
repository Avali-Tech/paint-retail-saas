import type { VariantPlan } from './catalogue.js';
import type { Random } from './random.js';

/** Packs a branch keeps of a product: plenty of small tins, a few 20-litre buckets. */
export function openingQuantity(
  random: Random,
  variant: Pick<VariantPlan, 'packSize' | 'unit'>,
): number {
  if (variant.unit === 'piece') return random.int(10, 40);
  if (variant.packSize <= 1) return random.int(12, 48);
  if (variant.packSize <= 5) return random.int(8, 30);
  if (variant.packSize <= 10) return random.int(4, 16);
  return random.int(3, 12);
}

/** How much a distributor order brings: whole cartons of small packs, a few big ones. */
export function purchaseQuantity(
  random: Random,
  variant: Pick<VariantPlan, 'packSize' | 'unit'>,
): number {
  if (variant.unit === 'piece' || variant.packSize <= 1) return random.pick([12, 24]);
  if (variant.packSize <= 5) return random.pick([6, 12]);
  if (variant.packSize <= 10) return random.pick([4, 8]);
  return random.int(2, 6);
}

export interface ReorderLevels {
  readonly minQuantity: number;
  readonly reorderLevel: number;
  readonly maxQuantity: number;
}

/** Minimum, reorder level and maximum for a product a branch normally keeps `usual` of. */
export function reorderLevels(usual: number): ReorderLevels {
  const minQuantity = Math.max(1, Math.round(usual * 0.25));
  const reorderLevel = Math.max(minQuantity + 1, Math.round(usual * 0.4));
  const maxQuantity = Math.max(reorderLevel + 1, Math.round(usual * 1.25));
  return { minQuantity, reorderLevel, maxQuantity };
}

/** Scheme units a distributor gives free: one per dozen. */
export function schemeFreeQuantity(quantity: number): number {
  return Math.floor(quantity / 12);
}
