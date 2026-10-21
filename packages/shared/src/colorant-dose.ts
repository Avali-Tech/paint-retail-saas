import type { ColorantUnit } from './paint-api.js';

/**
 * How much of a loose colorant one tinted pack takes, in the unit the colorant
 * is stocked in (round 8a). A formula doses in ml, g, shots or Y; a colorant is
 * stocked by the ml or by the g. ml and g convert through the colorant's density
 * (g per ml); shots and Y through the business's machine setting (ml each).
 */

/** The business's tinting machine units, in ml; null when not set. */
export interface TintUnitsMl {
  readonly shotMl: number | null;
  readonly yMl: number | null;
}

/** A colorant as stocked: loose, by the ml or by the g. */
export interface LooseColorant {
  readonly unit: 'ml' | 'g';
  readonly densityGPerMl: number | null;
}

/** Why a dose cannot be worked out, for the message. */
export type DoseGap = 'shot_not_set' | 'y_not_set' | 'density_not_set';

export type Dose =
  { readonly ok: true; readonly quantity: number } | { readonly ok: false; readonly gap: DoseGap };

/** Stock keeps 3 decimals. */
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** The dose of `amount` `unit` for one pack, in the colorant's own unit. */
export function colorantDose(
  amount: number,
  unit: ColorantUnit,
  colorant: LooseColorant,
  units: TintUnitsMl,
): Dose {
  if (unit === colorant.unit) return { ok: true, quantity: round3(amount) };
  if (unit === 'g') {
    // Weighed, stocked by the ml.
    if (colorant.densityGPerMl === null) return { ok: false, gap: 'density_not_set' };
    return { ok: true, quantity: round3(amount / colorant.densityGPerMl) };
  }
  let ml = amount;
  if (unit === 'shot') {
    if (units.shotMl === null) return { ok: false, gap: 'shot_not_set' };
    ml = amount * units.shotMl;
  } else if (unit === 'y') {
    if (units.yMl === null) return { ok: false, gap: 'y_not_set' };
    ml = amount * units.yMl;
  }
  if (colorant.unit === 'ml') return { ok: true, quantity: round3(ml) };
  // Dosed by volume, stocked by weight.
  if (colorant.densityGPerMl === null) return { ok: false, gap: 'density_not_set' };
  return { ok: true, quantity: round3(ml * colorant.densityGPerMl) };
}

/** A colorant variant can be dosed only when stocked loose: one ml or one g a unit. */
export const isLooseColorantPack = (pack: { packSize: number; unit: string }): boolean =>
  pack.packSize === 1 && (pack.unit === 'ml' || pack.unit === 'g');
