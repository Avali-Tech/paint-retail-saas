import { addDays, dayNumber } from './receivables/dates.js';

/**
 * The dashboard's sales tile (MVP 3 round 7b, docs/mvp-3/sales-reports.md): net sales today,
 * this week and this month to date, each against the same stretch of the period before,
 * and the last 14 days. Pure: the API reads one row per India-time day and this adds them up.
 *
 * Net sales are issued invoices, bills of supply and debit notes, less issued credit notes,
 * each on its own issue date; drafts and cancelled documents never count. The headline is
 * the taxable value (GST excluded); `valuePaise` adds the GST and cess (before round-off).
 */

/** India-time calendar days, both ends included (YYYY-MM-DD). */
export interface DayRange {
  readonly from: string;
  readonly to: string;
}

export interface SalesFigures {
  /** Taxable value of bills and debit notes less credit notes: GST excluded. */
  readonly taxablePaise: number;
  /** GST (CGST, SGST, IGST) and cess on the same documents, netted the same way. */
  readonly taxPaise: number;
  /** Taxable value plus GST: what customers were billed, before round-off. */
  readonly valuePaise: number;
  /** Invoices and bills of supply issued (notes are not bills). */
  readonly bills: number;
  readonly creditNotes: number;
  /** The bills' own taxable value over their number, before any note; null with no bills. */
  readonly averageBillPaise: number | null;
}

export type SalesPeriodKey = 'today' | 'week' | 'month';

export interface SalesPeriod {
  readonly key: SalesPeriodKey;
  readonly range: DayRange;
  readonly figures: SalesFigures;
  /** Yesterday; last week up to the same weekday; last month up to the same date. */
  readonly previousRange: DayRange;
  readonly previous: SalesFigures;
  /** Change in net taxable sales against `previous`, in basis points; null when that was 0. */
  readonly changeBps: number | null;
}

export interface SalesDay {
  readonly day: string;
  readonly taxablePaise: number;
  readonly bills: number;
}

/** GET /dashboard/sales. */
export interface SalesOverview {
  readonly generatedAt: string;
  /** Today in India. */
  readonly today: string;
  /** Today, this week (from Monday) and this month, in that order. */
  readonly periods: readonly SalesPeriod[];
  /** The last `SALES_TREND_DAYS` days, oldest first, days without sales as zeros. */
  readonly days: readonly SalesDay[];
}

/** One India-time day of sales, as the API adds it up from the documents. */
export interface DaySales {
  readonly day: string;
  /** Taxable value of the day's invoices and bills of supply alone. */
  readonly billsTaxablePaise: number;
  readonly taxablePaise: number;
  readonly taxPaise: number;
  readonly bills: number;
  readonly creditNotes: number;
}

export const SALES_TREND_DAYS = 14;

/** The day's weekday, Monday 0 to Sunday 6 (1970-01-01 was a Thursday). */
const weekday = (iso: string) => (dayNumber(iso) + 3) % 7;

const lastDayOfMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const pad = (value: number) => String(value).padStart(2, '0');

/** The current and previous stretch of each period, as of `today`. */
export function salesRanges(
  today: string,
): { key: SalesPeriodKey; range: DayRange; previousRange: DayRange }[] {
  const monday = addDays(today, -weekday(today));
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const lastYear = month === 1 ? year - 1 : year;
  const lastMonth = month === 1 ? 12 : month - 1;
  const lastMonthStart = `${String(lastYear)}-${pad(lastMonth)}-01`;
  const lastMonthDay = Math.min(day, lastDayOfMonth(lastYear, lastMonth));
  return [
    {
      key: 'today',
      range: { from: today, to: today },
      previousRange: { from: addDays(today, -1), to: addDays(today, -1) },
    },
    {
      key: 'week',
      range: { from: monday, to: today },
      previousRange: { from: addDays(monday, -7), to: addDays(today, -7) },
    },
    {
      key: 'month',
      range: { from: `${today.slice(0, 7)}-01`, to: today },
      previousRange: {
        from: lastMonthStart,
        to: `${String(lastYear)}-${pad(lastMonth)}-${pad(lastMonthDay)}`,
      },
    },
  ];
}

/** The first day the overview needs: the earliest of the previous stretches and the trend. */
export function salesOverviewStart(today: string): string {
  const starts = [
    addDays(today, 1 - SALES_TREND_DAYS),
    ...salesRanges(today).map((period) => period.previousRange.from),
  ];
  return starts.reduce((earliest, day) => (day < earliest ? day : earliest));
}

/** The days in `range` added up. */
export function sumSales(days: readonly DaySales[], range: DayRange): SalesFigures {
  let billsTaxable = 0;
  let taxable = 0;
  let tax = 0;
  let bills = 0;
  let creditNotes = 0;
  for (const day of days) {
    if (day.day < range.from || day.day > range.to) continue;
    billsTaxable += day.billsTaxablePaise;
    taxable += day.taxablePaise;
    tax += day.taxPaise;
    bills += day.bills;
    creditNotes += day.creditNotes;
  }
  return {
    taxablePaise: taxable,
    taxPaise: tax,
    valuePaise: taxable + tax,
    bills,
    creditNotes,
    averageBillPaise: bills === 0 ? null : Math.round(billsTaxable / bills),
  };
}

/** Change from `previous` to `current` in basis points (12.34% is 1234); null from zero. */
export function changeBasisPoints(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) * 10_000) / Math.abs(previous));
}

/** The tile's figures from the days' sales (any order, days without sales left out). */
export function salesOverview(
  today: string,
  days: readonly DaySales[],
  generatedAt: string,
): SalesOverview {
  const byDay = new Map(days.map((day) => [day.day, day]));
  return {
    generatedAt,
    today,
    periods: salesRanges(today).map(({ key, range, previousRange }) => {
      const figures = sumSales(days, range);
      const previous = sumSales(days, previousRange);
      return {
        key,
        range,
        figures,
        previousRange,
        previous,
        changeBps: changeBasisPoints(figures.taxablePaise, previous.taxablePaise),
      };
    }),
    days: Array.from({ length: SALES_TREND_DAYS }, (_, index) => {
      const day = addDays(today, index + 1 - SALES_TREND_DAYS);
      const found = byDay.get(day);
      return { day, taxablePaise: found?.taxablePaise ?? 0, bills: found?.bills ?? 0 };
    }),
  };
}
