import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLANNER_RATES,
  planStockUp,
  type PlannerRates,
  type StockUpLine,
  type StockUpSku,
} from './price-hike.js';

const hike = { hikeBasisPoints: 500, effectiveOn: '2026-11-01' };
const asOf = '2026-10-22'; // 10 days of the old price left

function sku(overrides: Partial<StockUpSku> = {}): StockUpSku {
  return {
    variantId: 'v-20l',
    unitCostPaise: 2_000_00,
    stockUnits: 20,
    soldUnits: 90,
    salesWindowDays: 90,
    deadStockRiskBps: null,
    ...overrides,
  };
}

describe('planStockUp', () => {
  it('stocks up to the break-even cover and prices it', () => {
    const plan = planStockUp(hike, [sku()], asOf);
    // r = 6 + 12 + 4 = 22 % a year; D* = 365 × 5 ÷ 22 = 82.95 days.
    // At the hike 20 − 10 = 10 units remain; 82 days need 82: buy 72.
    // They wait (2 × 10 + 72) ÷ 2 = 46 days on average: ₹1,44,000 × r × 46 ÷ 365.
    expect(plan).toEqual({
      daysToHike: 10,
      lines: [
        {
          variantId: 'v-20l',
          breakEvenDays: 82,
          breakEvenMonths: 2.7,
          coverDays: 82,
          unitsAtHike: 10,
          stockUpUnits: 72,
          stockUpPaise: 1_44_000_00,
          savingPaise: 7_200_00,
          holdingCostPaise: 1_088_88,
          moneyCostPaise: 2_177_76,
          deadStockCostPaise: 725_92,
          carryingCostPaise: 3_992_56,
          netSavingPaise: 3_207_44,
        } satisfies StockUpLine,
      ],
      stockUpPaise: 1_44_000_00,
      savingPaise: 7_200_00,
      carryingCostPaise: 3_992_56,
      netSavingPaise: 3_207_44,
    });
  });

  it('buys nothing for a SKU that does not sell or already has enough', () => {
    const plan = planStockUp(
      hike,
      [
        sku({ variantId: 'idle', soldUnits: 0 }),
        // A risky SKU: 4 + 12 + 38 % → D* = 32 days, 1.0 month; 90 units at the hike cover it.
        sku({
          variantId: 'full',
          stockUnits: 100,
          soldUnits: 30,
          salesWindowDays: 30,
          deadStockRiskBps: 3800,
        }),
      ],
      asOf,
    );
    expect(plan.lines).toMatchObject([
      {
        variantId: 'idle',
        stockUpUnits: 0,
        unitsAtHike: 20,
        carryingCostPaise: 0,
        netSavingPaise: 0,
      },
      {
        variantId: 'full',
        breakEvenDays: 32,
        breakEvenMonths: 1,
        unitsAtHike: 90,
        stockUpUnits: 0,
      },
    ]);
    expect(plan.stockUpPaise).toBe(0);
  });

  it('covers only up to the cap when holding costs nothing', () => {
    const free: PlannerRates = {
      holdingCostBps: 0,
      costOfMoneyBps: 0,
      deadStockRiskBps: 0,
      maxCoverDays: 90,
    };
    const plan = planStockUp(
      hike,
      [sku({ stockUnits: 0, soldUnits: 30, salesWindowDays: 30 })],
      asOf,
      free,
    );
    expect(plan.lines[0]).toMatchObject({
      breakEvenDays: null,
      breakEvenMonths: null,
      coverDays: 90,
      unitsAtHike: 0,
      stockUpUnits: 90,
      savingPaise: 9_000_00,
      carryingCostPaise: 0,
      netSavingPaise: 9_000_00,
    });
  });

  it('caps the cover at the plan’s limit', () => {
    const plan = planStockUp(
      { hikeBasisPoints: 2000, effectiveOn: '2026-11-01' },
      [sku()],
      asOf,
      DEFAULT_PLANNER_RATES,
    );
    expect(plan.lines[0]).toMatchObject({ breakEvenDays: 331, coverDays: 90, stockUpUnits: 80 });
  });

  it('plans nothing once the hike is in force', () => {
    for (const day of ['2026-11-01', '2026-11-05']) {
      const plan = planStockUp(hike, [sku()], day);
      expect(plan.daysToHike).toBeLessThanOrEqual(0);
      expect(plan.lines[0]).toMatchObject({ stockUpUnits: 0, unitsAtHike: 20, savingPaise: 0 });
    }
  });

  it('refuses inputs it cannot plan with', () => {
    const bad: [Partial<StockUpSku>, string][] = [
      [{ unitCostPaise: -1 }, 'Unit cost'],
      [{ stockUnits: 1.5 }, 'Stock units'],
      [{ soldUnits: -2 }, 'Sold units'],
      [{ salesWindowDays: 0 }, 'Sales window days'],
      [{ deadStockRiskBps: -1 }, 'Dead-stock risk'],
    ];
    for (const [overrides, message] of bad) {
      expect(() => planStockUp(hike, [sku(overrides)], asOf)).toThrow(message);
    }
    expect(() => planStockUp({ ...hike, hikeBasisPoints: -5 }, [], asOf)).toThrow(
      'Hike basis points',
    );
    const rates: [Partial<PlannerRates>, string][] = [
      [{ holdingCostBps: -1 }, 'Holding cost'],
      [{ costOfMoneyBps: -1 }, 'Cost of money'],
      [{ deadStockRiskBps: -1 }, 'Dead-stock risk'],
      [{ maxCoverDays: -1 }, 'Max cover days'],
    ];
    for (const [overrides, message] of rates) {
      expect(() => planStockUp(hike, [], asOf, { ...DEFAULT_PLANNER_RATES, ...overrides })).toThrow(
        message,
      );
    }
  });
});
