/**
 * Reorder levels from how fast a product sells and how long its supplier takes
 * to deliver: enough to last the lead time is the minimum, the lead time plus a
 * safety margin is when to reorder, and a month more is the most to hold.
 * Quantities are whole packs (rounded up), so a slow seller still keeps one.
 */

/** How many more days of sales the maximum holds beyond the reorder level. */
export const REORDER_COVER_DAYS = 30;
/** The lead time assumed for a product whose supplier has none on record. */
export const DEFAULT_LEAD_TIME_DAYS = 7;

export interface ReorderDemand {
  /** Net packs sold (sales less returns) over `days`. */
  readonly soldQuantity: number;
  readonly days: number;
  readonly leadTimeDays: number;
  readonly safetyDays: number;
}

export interface ReorderLevels {
  /** Packs sold per day, to 3 decimals. */
  readonly dailyRate: number;
  readonly minQuantity: number;
  readonly reorderLevel: number;
  readonly maxQuantity: number;
}

export function suggestReorderLevels(demand: ReorderDemand): ReorderLevels {
  const daily = Math.max(0, demand.soldQuantity) / demand.days;
  const packs = (days: number) => Math.max(0, Math.ceil(daily * days - 1e-9));
  const minQuantity = packs(demand.leadTimeDays);
  const reorderLevel = Math.max(1, packs(demand.leadTimeDays + demand.safetyDays));
  return {
    dailyRate: Math.round(daily * 1000) / 1000,
    minQuantity: Math.min(minQuantity, reorderLevel),
    reorderLevel,
    maxQuantity: reorderLevel + Math.max(1, packs(REORDER_COVER_DAYS)),
  };
}
