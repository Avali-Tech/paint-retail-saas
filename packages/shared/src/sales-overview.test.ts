import { describe, expect, it } from 'vitest';
import {
  SALES_TREND_DAYS,
  changeBasisPoints,
  salesOverview,
  salesOverviewStart,
  salesRanges,
  sumSales,
  type DaySales,
} from './sales-overview.js';

const day = (iso: string, taxable: number, extra: Partial<DaySales> = {}): DaySales => ({
  day: iso,
  billsTaxablePaise: taxable,
  taxablePaise: taxable,
  taxPaise: Math.round(taxable * 0.18),
  bills: 1,
  creditNotes: 0,
  ...extra,
});

describe('sales ranges', () => {
  it('compares today with yesterday, the week from Monday and the month to date', () => {
    // Saturday 17 October 2026.
    expect(salesRanges('2026-10-17')).toEqual([
      {
        key: 'today',
        range: { from: '2026-10-17', to: '2026-10-17' },
        previousRange: { from: '2026-10-16', to: '2026-10-16' },
      },
      {
        key: 'week',
        range: { from: '2026-10-12', to: '2026-10-17' },
        previousRange: { from: '2026-10-05', to: '2026-10-10' },
      },
      {
        key: 'month',
        range: { from: '2026-10-01', to: '2026-10-17' },
        previousRange: { from: '2026-09-01', to: '2026-09-17' },
      },
    ]);
  });

  it('starts the week on the day itself on a Monday, and ends it on Sunday', () => {
    expect(salesRanges('2026-10-12')[1]?.range).toEqual({ from: '2026-10-12', to: '2026-10-12' });
    expect(salesRanges('2026-10-18')[1]?.range).toEqual({ from: '2026-10-12', to: '2026-10-18' });
  });

  it('stops last month at its last day, and goes back a year in January', () => {
    expect(salesRanges('2026-10-31')[2]?.previousRange).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(salesRanges('2028-03-31')[2]?.previousRange).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
    expect(salesRanges('2027-01-15')[2]?.previousRange).toEqual({
      from: '2026-12-01',
      to: '2026-12-15',
    });
  });

  it('reads back as far as the earliest stretch it compares or charts', () => {
    expect(salesOverviewStart('2026-10-17')).toBe('2026-09-01');
    expect(salesOverviewStart('2026-10-02')).toBe('2026-09-01');
    expect(salesOverviewStart('2026-03-01')).toBe('2026-02-01');
  });
});

describe('sales figures', () => {
  it('add up the days in a range, the average over the bills alone', () => {
    const days = [
      day('2026-10-16', 50_000),
      day('2026-10-17', 30_000, { bills: 2, billsTaxablePaise: 40_000, creditNotes: 1 }),
      day('2026-10-18', 99_000),
    ];
    expect(sumSales(days, { from: '2026-10-16', to: '2026-10-17' })).toEqual({
      taxablePaise: 80_000,
      taxPaise: 14_400,
      valuePaise: 94_400,
      bills: 3,
      creditNotes: 1,
      averageBillPaise: 30_000,
    });
    expect(sumSales(days, { from: '2026-10-01', to: '2026-10-15' }).averageBillPaise).toBeNull();
  });

  it('give the change in basis points, none from nothing', () => {
    expect(changeBasisPoints(11_000, 10_000)).toBe(1_000);
    expect(changeBasisPoints(5_000, 10_000)).toBe(-5_000);
    expect(changeBasisPoints(10_000, 0)).toBeNull();
    // A period that was net negative (more credited than billed) still compares.
    expect(changeBasisPoints(1_000, -1_000)).toBe(20_000);
  });
});

describe('sales overview', () => {
  it('builds every period and a trend of the last 14 days with zeros', () => {
    const days = [
      day('2026-10-17', 20_000),
      day('2026-10-16', 10_000),
      day('2026-10-10', 40_000),
      day('2026-09-15', 5_000),
    ];
    const overview = salesOverview('2026-10-17', days, '2026-10-17T06:00:00.000Z');
    expect(overview.today).toBe('2026-10-17');
    expect(overview.generatedAt).toBe('2026-10-17T06:00:00.000Z');
    expect(
      overview.periods.map((p) => [p.key, p.figures.taxablePaise, p.previous.taxablePaise]),
    ).toEqual([
      ['today', 20_000, 10_000],
      ['week', 30_000, 40_000],
      ['month', 70_000, 5_000],
    ]);
    expect(overview.periods.map((p) => p.changeBps)).toEqual([10_000, -2_500, 130_000]);
    expect(overview.days).toHaveLength(SALES_TREND_DAYS);
    expect(overview.days[0]).toEqual({ day: '2026-10-04', taxablePaise: 0, bills: 0 });
    expect(overview.days.at(-1)).toEqual({ day: '2026-10-17', taxablePaise: 20_000, bills: 1 });
    expect(overview.days.find((d) => d.day === '2026-10-10')?.taxablePaise).toBe(40_000);
  });
});
