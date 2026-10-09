import {
  DEFAULT_WASTAGE_BPS,
  ESTIMATE_TIERS,
  type EstimateLinePurpose,
  type EstimateTier,
} from '../paint-api.js';
import { cheapestPackMix, type PackMix, type PackOption } from './pack-mix.js';
import {
  paintMillilitres,
  primerMillilitres,
  puttyGrams,
  type EstimatorSurface,
} from './quantities.js';

/** A paint or primer product: its coverage (null = not known) and packs on sale (mL). */
export interface CoatingChoice {
  readonly coverageSqftPerLitre: number | null;
  readonly defaultCoats: number | null;
  readonly packs: readonly PackOption[];
}

/** One tier's products. Primer and putty are optional; their packs are mL and g. */
export interface TierChoice {
  readonly tier: EstimateTier;
  readonly paint: CoatingChoice;
  readonly primer?: CoatingChoice | null;
  readonly putty?: { readonly packs: readonly PackOption[] } | null;
}

export interface EstimatorLine {
  readonly purpose: EstimateLinePurpose;
  readonly variantId: string;
  readonly quantity: number;
  readonly unitPricePaise: number;
  readonly totalPaise: number;
}

/** Why a tier cannot be priced: a product without coverage, or without packs on sale. */
export interface TierProblem {
  readonly problem: 'noCoverage' | 'noPacks';
  readonly purpose: EstimateLinePurpose;
}

export interface TierEstimate {
  readonly tier: EstimateTier;
  /** Paint needed, in mL (litres = paintMl / 1000). */
  readonly paintMl: number;
  readonly primerMl: number;
  readonly puttyGrams: number;
  /** Paint first, then primer, then putty; each largest pack first. */
  readonly lines: readonly EstimatorLine[];
  readonly totalPaise: number;
}

/** A tier that could not be priced, and why. */
export type TierFailure = TierProblem & { readonly tier: EstimateTier };

export type TierOutcome = TierEstimate | TierFailure;

function linesOf(purpose: EstimateLinePurpose, mix: PackMix): EstimatorLine[] {
  return mix.lines.map((line) => ({
    purpose,
    variantId: line.variantId,
    quantity: line.quantity,
    unitPricePaise: line.unitPricePaise,
    totalPaise: line.totalPaise,
  }));
}

/**
 * One tier (spec §6.2): litres for the paint, one coat of primer and the putty
 * on the surfaces that take them, each bought as the cheapest pack mix that
 * never under-supplies.
 */
export function estimateTier(
  surfaces: readonly EstimatorSurface[],
  choice: TierChoice,
  wastageBps: number = DEFAULT_WASTAGE_BPS,
): TierOutcome {
  const { tier, paint } = choice;
  if (paint.coverageSqftPerLitre === null) return { tier, problem: 'noCoverage', purpose: 'paint' };
  const paintMl = paintMillilitres(
    surfaces,
    { coverageSqftPerLitre: paint.coverageSqftPerLitre, defaultCoats: paint.defaultCoats },
    wastageBps,
  );
  const paintMix = cheapestPackMix(paint.packs, paintMl);
  if (paintMix === null) return { tier, problem: 'noPacks', purpose: 'paint' };
  const lines = linesOf('paint', paintMix);

  let primerMl = 0;
  const primer = choice.primer ?? null;
  if (primer !== null && surfaces.some((surface) => surface.primer)) {
    if (primer.coverageSqftPerLitre === null)
      return { tier, problem: 'noCoverage', purpose: 'primer' };
    primerMl = primerMillilitres(surfaces, primer.coverageSqftPerLitre, wastageBps);
    const mix = cheapestPackMix(primer.packs, primerMl);
    if (mix === null) return { tier, problem: 'noPacks', purpose: 'primer' };
    lines.push(...linesOf('primer', mix));
  }

  let grams = 0;
  const putty = choice.putty ?? null;
  if (putty !== null && surfaces.some((surface) => surface.putty)) {
    grams = puttyGrams(surfaces, wastageBps);
    const mix = cheapestPackMix(putty.packs, grams);
    if (mix === null) return { tier, problem: 'noPacks', purpose: 'putty' };
    lines.push(...linesOf('putty', mix));
  }

  return {
    tier,
    paintMl,
    primerMl,
    puttyGrams: grams,
    lines,
    totalPaise: lines.reduce((sum, line) => sum + line.totalPaise, 0),
  };
}

export const isTierProblem = (outcome: TierOutcome): outcome is TierFailure => 'problem' in outcome;

/** Good / better / best: every tier through the same function, in tier order. */
export function estimateTiers(
  surfaces: readonly EstimatorSurface[],
  choices: readonly TierChoice[],
  wastageBps: number = DEFAULT_WASTAGE_BPS,
): TierOutcome[] {
  return [...choices]
    .sort((a, b) => ESTIMATE_TIERS.indexOf(a.tier) - ESTIMATE_TIERS.indexOf(b.tier))
    .map((choice) => estimateTier(surfaces, choice, wastageBps));
}
