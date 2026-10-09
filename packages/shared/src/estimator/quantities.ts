import {
  DEFAULT_WASTAGE_BPS,
  MAX_COATS,
  MAX_WASTAGE_BPS,
  MIN_COATS,
  coatsFor,
  type SurfaceCondition,
} from '../paint-api.js';

/**
 * One surface as the estimator sees it: its net area (doors and windows already
 * deducted, see surfaceNetAreaSqft), its coats (null = the product's default)
 * and whether it gets primer and putty.
 */
export interface EstimatorSurface {
  readonly netAreaSqft: number;
  readonly coats: number | null;
  readonly condition: SurfaceCondition;
  readonly primer: boolean;
  readonly putty: boolean;
}

/**
 * Putty, in grams per sq ft for two coats, by condition (spec §6.2: "putty kg
 * per sq ft by condition"). Planning figures from brand data sheets (about
 * 1 kg per 15 sq ft on new plaster); a damaged wall takes more.
 */
export const PUTTY_GRAMS_PER_SQFT: Readonly<Record<SurfaceCondition, number>> = {
  new: 70,
  repaint: 40,
  damaged: 100,
};

/** Hundredths of a sq ft, so 2-decimal areas add exactly. */
function centiArea(surface: EstimatorSurface): bigint {
  const value = surface.netAreaSqft;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('A surface area must be zero or more');
  }
  return BigInt(Math.round(value * 100));
}

function checkWastage(wastageBps: number): bigint {
  if (!Number.isInteger(wastageBps) || wastageBps < 0 || wastageBps > MAX_WASTAGE_BPS) {
    throw new RangeError(`Wastage must be 0 to ${String(MAX_WASTAGE_BPS / 100)} %`);
  }
  return BigInt(10_000 + wastageBps);
}

function checkCoats(coats: number): bigint {
  if (!Number.isInteger(coats) || coats < MIN_COATS || coats > MAX_COATS) {
    throw new RangeError(
      `Coats must be a whole number from ${String(MIN_COATS)} to ${String(MAX_COATS)}`,
    );
  }
  return BigInt(coats);
}

const ceilDiv = (numerator: bigint, denominator: bigint) =>
  Number((numerator + denominator - 1n) / denominator);

/**
 * Millilitres for Σ(area × coats) at a coverage, with wastage, rounded up (the
 * first half of "never under-supplies"):
 * mL = area/100 × coats × (1e4 + w)/1e4 ÷ (coverage/100) × 1000 = area × coats × (1e4 + w) ÷ (10 × coverage).
 */
function millilitres(
  coatedCentiArea: bigint,
  coverageSqftPerLitre: number,
  wastageBps: number,
): number {
  const coverage = Math.round(coverageSqftPerLitre * 100);
  if (!Number.isFinite(coverageSqftPerLitre) || coverage <= 0) {
    throw new RangeError('Coverage must be more than zero');
  }
  return ceilDiv(coatedCentiArea * checkWastage(wastageBps), BigInt(coverage) * 10n);
}

/** Paint for every surface: each surface's coats, else the product's default (coatsFor). */
export function paintMillilitres(
  surfaces: readonly EstimatorSurface[],
  product: { readonly coverageSqftPerLitre: number; readonly defaultCoats: number | null },
  wastageBps: number = DEFAULT_WASTAGE_BPS,
): number {
  let coated = 0n;
  for (const surface of surfaces) {
    coated += centiArea(surface) * checkCoats(coatsFor(surface.coats, product.defaultCoats));
  }
  return millilitres(coated, product.coverageSqftPerLitre, wastageBps);
}

/** Primer: one coat on the surfaces that get it. */
export function primerMillilitres(
  surfaces: readonly EstimatorSurface[],
  coverageSqftPerLitre: number,
  wastageBps: number = DEFAULT_WASTAGE_BPS,
): number {
  let area = 0n;
  for (const surface of surfaces) {
    if (surface.primer) area += centiArea(surface);
  }
  return millilitres(area, coverageSqftPerLitre, wastageBps);
}

/** Putty grams on the surfaces that get it, by condition, with wastage, rounded up. */
export function puttyGrams(
  surfaces: readonly EstimatorSurface[],
  wastageBps: number = DEFAULT_WASTAGE_BPS,
): number {
  let grams = 0n;
  for (const surface of surfaces) {
    if (surface.putty)
      grams += centiArea(surface) * BigInt(PUTTY_GRAMS_PER_SQFT[surface.condition]);
  }
  // centi-sqft × g/sqft ÷ 100 × (1e4 + w) ÷ 1e4
  return ceilDiv(grams * checkWastage(wastageBps), 1_000_000n);
}
