import { DEFAULT_PLANNER_RATES, type PriceHikePlanInput } from '@paint/shared';
import { parsePercent } from './scheme-form.js';

// The price-hike planner's fields as typed, and what the API takes (P2-M33, [PO-33]).

export interface PlanValues {
  readonly brandId: string;
  /** Percent, e.g. "4.5". */
  readonly hike: string;
  readonly effectiveOn: string;
  /** Empty for every store the member works at. */
  readonly storeId: string;
  readonly window: string;
  /** Annual percents. */
  readonly holding: string;
  readonly money: string;
  readonly deadStock: string;
  readonly cover: string;
}

export type PlanProblem =
  | 'priceHike.invalid.brand'
  | 'priceHike.invalid.hike'
  | 'priceHike.invalid.window'
  | 'priceHike.invalid.rate'
  | 'priceHike.invalid.cover';

const percentText = (bps: number) => String(bps / 100);

/** The planner's defaults: a week ahead, 90 days of sales, the [PO-33] rates. */
export function newPlan(effectiveOn: string): PlanValues {
  return {
    brandId: '',
    hike: '',
    effectiveOn,
    storeId: '',
    window: '90',
    holding: percentText(DEFAULT_PLANNER_RATES.holdingCostBps),
    money: percentText(DEFAULT_PLANNER_RATES.costOfMoneyBps),
    deadStock: percentText(DEFAULT_PLANNER_RATES.deadStockRiskBps),
    cover: String(DEFAULT_PLANNER_RATES.maxCoverDays),
  };
}

/** A whole number from `min` to `max`; null if not one. */
function whole(text: string, min: number, max: number): number | null {
  const value = text.trim();
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return number >= min && number <= max ? number : null;
}

/** An annual rate typed as a percent, "0" allowed; null if not one. */
const rate = (text: string) => (text.trim() === '0' ? 0 : parsePercent(text));

/** The fields, checked, as the API takes them; or the first problem. */
export function readPlan(
  values: PlanValues,
): { readonly input: PriceHikePlanInput } | { readonly problem: PlanProblem } {
  if (values.brandId === '') return { problem: 'priceHike.invalid.brand' };
  const hike = parsePercent(values.hike);
  if (hike === null || hike > 5_000) return { problem: 'priceHike.invalid.hike' };
  const window = whole(values.window, 7, 365);
  if (window === null) return { problem: 'priceHike.invalid.window' };
  const holding = rate(values.holding);
  const money = rate(values.money);
  const deadStock = rate(values.deadStock);
  if (holding === null || money === null || deadStock === null) {
    return { problem: 'priceHike.invalid.rate' };
  }
  const cover = whole(values.cover, 1, 365);
  if (cover === null) return { problem: 'priceHike.invalid.cover' };
  return {
    input: {
      brandId: values.brandId,
      hikeBasisPoints: hike,
      effectiveOn: values.effectiveOn,
      productIds: [],
      categoryIds: [],
      storeId: values.storeId === '' ? null : values.storeId,
      salesWindowDays: window,
      holdingCostBps: holding,
      costOfMoneyBps: money,
      deadStockRiskBps: deadStock,
      maxCoverDays: cover,
    },
  };
}
