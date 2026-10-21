import { describe, expect, it } from 'vitest';
import { DEFAULT_LEAD_TIME_DAYS, suggestReorderLevels } from './reorder-suggestion.js';

describe('suggestReorderLevels', () => {
  it('covers the lead time, then a safety margin, then a month', () => {
    // 90 packs in 90 days: one a day; 5 days to deliver, 7 days of safety.
    expect(
      suggestReorderLevels({ soldQuantity: 90, days: 90, leadTimeDays: 5, safetyDays: 7 }),
    ).toEqual({ dailyRate: 1, minQuantity: 5, reorderLevel: 12, maxQuantity: 42 });
  });

  it('rounds up to whole packs, so a slow seller still keeps one', () => {
    expect(
      suggestReorderLevels({
        soldQuantity: 2,
        days: 90,
        leadTimeDays: DEFAULT_LEAD_TIME_DAYS,
        safetyDays: 7,
      }),
    ).toEqual({ dailyRate: 0.022, minQuantity: 1, reorderLevel: 1, maxQuantity: 2 });
  });

  it('does not round a whole number of packs up by floating-point error', () => {
    // 0.1 a day × 30 days is 3 packs, not 4.
    expect(
      suggestReorderLevels({ soldQuantity: 9, days: 90, leadTimeDays: 30, safetyDays: 0 }),
    ).toEqual({ dailyRate: 0.1, minQuantity: 3, reorderLevel: 3, maxQuantity: 6 });
  });

  it('treats more returns than sales as no demand', () => {
    expect(
      suggestReorderLevels({ soldQuantity: -3, days: 30, leadTimeDays: 3, safetyDays: 2 }),
    ).toEqual({ dailyRate: 0, minQuantity: 0, reorderLevel: 1, maxQuantity: 2 });
  });
});
