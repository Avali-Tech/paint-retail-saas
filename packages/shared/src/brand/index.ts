/**
 * Brand money engines (roadmap P2-M33 and P2-M35, MVP 3 spec §6.3): scheme
 * slab progress, expected vs received benefits, the price-hike planner and the
 * brand margin formula. Pure: the API loads the schemes, GRNs, sales and
 * ledgers; these only compute, exactly, in paise and millilitres.
 */
export {
  DEFAULT_SETTLEMENT_DAYS,
  DEFAULT_SLAB_MODE,
  SLAB_MEASURES,
  SLAB_MODES,
  assertScheme,
  lineCounts,
  slabBenefits,
  slabIndexFor,
  type BrandScheme,
  type FreeGoods,
  type SchemeGrnLine,
  type SchemePoints,
  type SchemeSlab,
  type SlabBenefit,
  type SlabBenefits,
  type SlabMeasure,
  type SlabMode,
} from './scheme.js';
export { schemeProgress, type NextSlab, type SchemeProgress, type SlabRef } from './progress.js';
export {
  CLAIM_STATUSES,
  claimsAgeing,
  schemeClaim,
  type ClaimStatus,
  type ClaimsAgeingRow,
  type FreeGoodsClaim,
  type MoneyClaim,
  type PointsClaim,
  type ReceivedBenefit,
  type SchemeClaim,
} from './claims.js';
export {
  DEFAULT_PLANNER_RATES,
  planStockUp,
  type PlannerRates,
  type PriceHike,
  type StockUpLine,
  type StockUpPlan,
  type StockUpSku,
} from './price-hike.js';
export {
  DEFAULT_COST_OF_MONEY_BPS,
  MARGIN_DIMENSIONS,
  brandMargins,
  marginBps,
  paiseDays,
  sumMargins,
  type BrandSchemeMoney,
  type MarginDimension,
  type MarginFigures,
  type MarginOptions,
  type MarginRow,
  type MarginSlice,
  type OutstandingSpan,
} from './margin.js';
export {
  BRAND_PROFITABILITY_PERMISSION,
  DEFAULT_POINT_VALUE_PAISE,
  PROFITABILITY_GROUPS,
  PROFITABILITY_MAX_DAYS,
  previousQuarter,
  type BrandProfitabilityQuery,
  type BrandProfitabilityRow,
  type BrandProfitabilityView,
  type ProfitabilityGroup,
  type ProfitabilitySliceView,
} from './profitability-api.js';
