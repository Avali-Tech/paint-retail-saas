import { daysBetween } from '../receivables/dates.js';
import {
  BPS,
  DAYS_PER_YEAR,
  assertNonNegative,
  assertPositive,
  divCeil,
  divFloor,
  maxBig,
  toSafe,
} from './arith.js';

/**
 * Price-hike planner (roadmap P2-M33, research; spec §6.3): when a brand
 * announces a price rise, how much of each SKU to buy before it takes effect.
 *
 * The model. A unit bought at today's cost C instead of after the hike saves
 * C × h (h the hike). Held t days before it sells, it costs C × r × t ÷ 365,
 * where r is the annual carrying rate: holding cost (storage, insurance,
 * handling) + cost of money ([PO-5]) + dead-stock risk (the share that never
 * sells, per year held). A unit is worth buying ahead while it sells within
 *
 *   break-even days D* = 365 × h ÷ r   (no limit when r is 0)
 *
 * of the hike. Units are bought as late as the old price allows (the day
 * before the hike) and sold at the SKU's average daily rate q = sold ÷ window
 * days, oldest first. So:
 *
 *   cover days       T = min(D*, maxCoverDays)
 *   stock at hike    S = stock − q × (days until the hike)
 *   stock-up units   U = ⌊q × T − max(S, 0)⌋, at least 0
 *   cash tied up       = U × C
 *   saving             = ⌊U × C × h⌋
 *   carrying cost      = ⌈U × C × r × A ÷ 365⌉ per component, where A is the
 *                        stock-up units' average days held after the hike:
 *                        max(S, 0) ÷ q + U ÷ (2q)
 *   net saving         = saving − carrying cost
 *
 * Rates are basis points (500 = 5 %; annual ones per year). Saving is rounded
 * down and each cost up, so the net saving is never overstated.
 */

export interface PriceHike {
  /** The rise in basis points of today's cost (500 = 5 %). */
  readonly hikeBasisPoints: number;
  /** The first day the new price applies. */
  readonly effectiveOn: string;
}

/** Annual rates in basis points, and the furthest ahead to stock. */
export interface PlannerRates {
  readonly holdingCostBps: number;
  readonly costOfMoneyBps: number;
  readonly deadStockRiskBps: number;
  /** Never cover more than this many days of sales after the hike. */
  readonly maxCoverDays: number;
}

/** Holding 6 %, cost of money 12 % ([PO-5]), dead-stock risk 4 % a year; at most 90 days' cover. */
export const DEFAULT_PLANNER_RATES: PlannerRates = {
  holdingCostBps: 600,
  costOfMoneyBps: 1200,
  deadStockRiskBps: 400,
  maxCoverDays: 90,
};

export interface StockUpSku {
  readonly variantId: string;
  /** Today's purchase cost of one unit, before the hike. */
  readonly unitCostPaise: number;
  readonly stockUnits: number;
  /** Units sold over the last `salesWindowDays` days: the average rate is their ratio. */
  readonly soldUnits: number;
  readonly salesWindowDays: number;
  /** This SKU's dead-stock risk a year; null for the plan's rate. */
  readonly deadStockRiskBps: number | null;
}

export interface StockUpLine {
  readonly variantId: string;
  /** Days of sales after the hike worth holding, D* (rounded down); null when unlimited. */
  readonly breakEvenDays: number | null;
  /** D* in months (12 × h ÷ r), to one decimal rounded down; null when unlimited. */
  readonly breakEvenMonths: number | null;
  readonly coverDays: number;
  /** Units expected in stock when the hike starts, rounded down; 0 if sold out before. */
  readonly unitsAtHike: number;
  readonly stockUpUnits: number;
  /** Cash tied up: stock-up units at today's cost. */
  readonly stockUpPaise: number;
  readonly savingPaise: number;
  readonly holdingCostPaise: number;
  readonly moneyCostPaise: number;
  readonly deadStockCostPaise: number;
  /** holding + money + dead stock. */
  readonly carryingCostPaise: number;
  /** saving − carrying cost. */
  readonly netSavingPaise: number;
}

export interface StockUpPlan {
  /** Days from the as-of day to the hike; 0 or less means it is already in force. */
  readonly daysToHike: number;
  readonly lines: readonly StockUpLine[];
  readonly stockUpPaise: number;
  readonly savingPaise: number;
  readonly carryingCostPaise: number;
  readonly netSavingPaise: number;
}

function assertRates(rates: PlannerRates): void {
  assertNonNegative(rates.holdingCostBps, 'Holding cost');
  assertNonNegative(rates.costOfMoneyBps, 'Cost of money');
  assertNonNegative(rates.deadStockRiskBps, 'Dead-stock risk');
  assertNonNegative(rates.maxCoverDays, 'Max cover days');
}

function planSku(
  sku: StockUpSku,
  hikeBps: bigint,
  daysToHike: number,
  rates: PlannerRates,
): StockUpLine {
  assertNonNegative(sku.unitCostPaise, 'Unit cost');
  assertNonNegative(sku.stockUnits, 'Stock units');
  assertNonNegative(sku.soldUnits, 'Sold units');
  assertPositive(sku.salesWindowDays, 'Sales window days');
  if (sku.deadStockRiskBps !== null) assertNonNegative(sku.deadStockRiskBps, 'Dead-stock risk');
  const components = [
    BigInt(rates.holdingCostBps),
    BigInt(rates.costOfMoneyBps),
    BigInt(sku.deadStockRiskBps ?? rates.deadStockRiskBps),
  ] as const;
  const rate = components[0] + components[1] + components[2];
  const breakEven = rate === 0n ? null : divFloor(DAYS_PER_YEAR * hikeBps, rate);
  const coverDays =
    breakEven === null
      ? rates.maxCoverDays
      : Math.min(toSafe(breakEven, 'Days'), rates.maxCoverDays);

  const window = BigInt(sku.salesWindowDays);
  const sold = BigInt(sku.soldUnits);
  const cost = BigInt(sku.unitCostPaise);
  // Units are scaled by the window so the daily rate (sold ÷ window) stays whole.
  const days = BigInt(Math.max(daysToHike, 0));
  const atHike = maxBig(BigInt(sku.stockUnits) * window - sold * days, 0n);
  const units =
    daysToHike <= 0 ? 0n : maxBig(divFloor(sold * BigInt(coverDays) - atHike, window), 0n);
  // Average days a stock-up unit waits after the hike: (2 × atHike + U × window) ÷ (2 × sold).
  const carry = (componentBps: bigint) =>
    units === 0n
      ? 0n
      : divCeil(
          cost * units * componentBps * (2n * atHike + units * window),
          2n * sold * BPS * DAYS_PER_YEAR,
        );
  const [holding, money, dead] = components.map(carry) as [bigint, bigint, bigint];
  const saving = divFloor(units * cost * hikeBps, BPS);
  const carrying = holding + money + dead;
  return {
    variantId: sku.variantId,
    breakEvenDays: breakEven === null ? null : toSafe(breakEven, 'Days'),
    breakEvenMonths: rate === 0n ? null : Number(divFloor(120n * hikeBps, rate)) / 10,
    coverDays,
    unitsAtHike: toSafe(atHike / window, 'Units'),
    stockUpUnits: toSafe(units, 'Units'),
    stockUpPaise: toSafe(units * cost, 'Stock-up value'),
    savingPaise: toSafe(saving, 'Saving'),
    holdingCostPaise: toSafe(holding, 'Holding cost'),
    moneyCostPaise: toSafe(money, 'Cost of money'),
    deadStockCostPaise: toSafe(dead, 'Dead-stock cost'),
    carryingCostPaise: toSafe(carrying, 'Carrying cost'),
    netSavingPaise: toSafe(saving - carrying, 'Net saving'),
  };
}

/** The stock-up plan for a brand's SKUs ahead of an announced hike, as of a day. */
export function planStockUp(
  hike: PriceHike,
  skus: readonly StockUpSku[],
  asOf: string,
  rates: PlannerRates = DEFAULT_PLANNER_RATES,
): StockUpPlan {
  assertNonNegative(hike.hikeBasisPoints, 'Hike basis points');
  assertRates(rates);
  const daysToHike = daysBetween(asOf, hike.effectiveOn);
  const lines = skus.map((sku) => planSku(sku, BigInt(hike.hikeBasisPoints), daysToHike, rates));
  const total = (pick: (line: StockUpLine) => number) =>
    toSafe(
      lines.reduce((sum, line) => sum + BigInt(pick(line)), 0n),
      'Total',
    );
  return {
    daysToHike,
    lines,
    stockUpPaise: total((line) => line.stockUpPaise),
    savingPaise: total((line) => line.savingPaise),
    carryingCostPaise: total((line) => line.carryingCostPaise),
    netSavingPaise: total((line) => line.netSavingPaise),
  };
}
