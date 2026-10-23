/**
 * Paint estimator (roadmap P2-M29, spec §6.2): pure functions, no IO. Surfaces
 * → litres (and primer, putty) → the cheapest pack mix that never
 * under-supplies, for each of the good / better / best products. The surface
 * areas themselves come from paint-api.ts (surfaceNetAreaSqft).
 */
export {
  MAX_PACK_MIX_STEPS,
  cheapestPackMix,
  type PackMix,
  type PackMixLine,
  type PackOption,
} from './pack-mix.js';
export { packAmount, packsOf, type PackMeasure, type VariantForSale } from './packs.js';
export {
  PUTTY_GRAMS_PER_SQFT,
  paintMillilitres,
  primerMillilitres,
  puttyGrams,
  type EstimatorSurface,
} from './quantities.js';
export {
  estimateTier,
  estimateTiers,
  isTierProblem,
  type CoatingChoice,
  type EstimatorLine,
  type TierChoice,
  type TierEstimate,
  type TierFailure,
  type TierOutcome,
  type TierProblem,
} from './option.js';
