import { allocateProportionally, at } from '../gst/arith.js';
import { dayNumber } from '../receivables/dates.js';
import {
  BPS,
  DAYS_PER_YEAR,
  assertNonNegative,
  divHalfEven,
  maxBig,
  minBig,
  toSafe,
} from './arith.js';

/**
 * Brand profitability (roadmap P2-M35, spec §6.3): the contribution a brand,
 * product or store made over a period.
 *
 *   net sales     = taxable value of invoices − taxable value of credit notes
 *   − cost        = stock-ledger average cost of units sold − of units returned
 *   + schemes     = scheme money received + still expected (outstanding, not below 0)
 *   − credit cost = Σ (outstanding paise × days) × cost of money ÷ 365  [PO-5]
 *   − loyalty     = points paid on the brand, valued in paise (bill-to and painter)
 *   = contribution;  margin = contribution ÷ net sales (basis points)
 *
 * Schemes are per brand, so each brand's scheme money is spread over its
 * slices in proportion to their cost (else net sales, else evenly), largest
 * remainder first, so the slices add up to the brand exactly. Credit cost is
 * rounded half-even per slice and the margin half-even; every total is the sum
 * of its slices, so a brand's figures always add up.
 *
 * Free goods are not added: they enter stock at zero cost, which already
 * lowers the average cost of what is sold [CA-6].
 */

/** One brand, product and store's figures for the period, in paise (several rows add up). */
export interface MarginRow {
  readonly brandId: string;
  readonly productId: string;
  readonly storeId: string;
  /** Taxable value of issued invoices. */
  readonly invoicedPaise: number;
  /** Taxable value of credit notes against them. */
  readonly creditNotePaise: number;
  /** Average cost of the units invoiced. */
  readonly costOfSalesPaise: number;
  /** Average cost of the units that came back on credit notes. */
  readonly costReturnedPaise: number;
  /** Σ outstanding × days the brand's sales stayed unpaid in the period: see {@link paiseDays}. */
  readonly creditPaiseDays: number;
  /** Loyalty points paid to customers (bill-to) on these sales, valued in paise. */
  readonly loyaltyPaise: number;
  /** Painter points paid on these sales, valued in paise. */
  readonly painterPointsPaise: number;
}

/** A brand's scheme money for the period. */
export interface BrandSchemeMoney {
  readonly brandId: string;
  readonly receivedPaise: number;
  /** Still expected: expected − received, not below 0. */
  readonly expectedPaise: number;
}

export const MARGIN_DIMENSIONS = ['product', 'store'] as const;
/** What to split a brand by besides itself. */
export type MarginDimension = (typeof MARGIN_DIMENSIONS)[number];

export interface MarginOptions {
  /** Split each brand by product, store, both, or neither. */
  readonly groupBy: readonly MarginDimension[];
  /** The business's cost of money a year, in basis points ([PO-5]). */
  readonly costOfMoneyBps: number;
}

/** [PO-5] default: 12 % a year. */
export const DEFAULT_COST_OF_MONEY_BPS = 1200;

export interface MarginFigures {
  readonly invoicedPaise: number;
  readonly creditNotePaise: number;
  readonly netSalesPaise: number;
  readonly costPaise: number;
  readonly grossMarginPaise: number;
  readonly schemeReceivedPaise: number;
  readonly schemeExpectedPaise: number;
  readonly creditCostPaise: number;
  readonly loyaltyPaise: number;
  readonly painterPointsPaise: number;
  readonly contributionPaise: number;
  /** Contribution ÷ net sales in basis points, half-even; null when net sales are not above 0. */
  readonly marginBps: number | null;
}

export interface MarginSlice extends MarginFigures {
  readonly brandId: string;
  /** Null when not split by product (or for scheme money no product carried). */
  readonly productId: string | null;
  readonly storeId: string | null;
}

interface Sums {
  invoiced: bigint;
  credited: bigint;
  cost: bigint;
  returned: bigint;
  paiseDays: bigint;
  loyalty: bigint;
  painter: bigint;
}

const ZERO: Sums = {
  invoiced: 0n,
  credited: 0n,
  cost: 0n,
  returned: 0n,
  paiseDays: 0n,
  loyalty: 0n,
  painter: 0n,
};

function assertRow(row: MarginRow): void {
  assertNonNegative(row.invoicedPaise, 'Invoiced');
  assertNonNegative(row.creditNotePaise, 'Credit notes');
  assertNonNegative(row.costOfSalesPaise, 'Cost of sales');
  assertNonNegative(row.costReturnedPaise, 'Cost returned');
  assertNonNegative(row.creditPaiseDays, 'Credit paise-days');
  assertNonNegative(row.loyaltyPaise, 'Loyalty');
  assertNonNegative(row.painterPointsPaise, 'Painter points');
}

/** Contribution ÷ net sales in basis points, half-even; null without positive net sales. */
export function marginBps(contributionPaise: number, netSalesPaise: number): number | null {
  if (netSalesPaise <= 0) return null;
  return toSafe(divHalfEven(BigInt(contributionPaise) * BPS, BigInt(netSalesPaise)), 'Margin');
}

function figures(
  sums: Sums,
  received: number,
  expected: number,
  costOfMoney: bigint,
): MarginFigures {
  const netSales = sums.invoiced - sums.credited;
  const cost = sums.cost - sums.returned;
  const creditCost = divHalfEven(sums.paiseDays * costOfMoney, BPS * DAYS_PER_YEAR);
  const contribution =
    netSales -
    cost +
    BigInt(received) +
    BigInt(expected) -
    creditCost -
    sums.loyalty -
    sums.painter;
  const netSalesPaise = toSafe(netSales, 'Net sales');
  const contributionPaise = toSafe(contribution, 'Contribution');
  return {
    invoicedPaise: toSafe(sums.invoiced, 'Invoiced'),
    creditNotePaise: toSafe(sums.credited, 'Credit notes'),
    netSalesPaise,
    costPaise: toSafe(cost, 'Cost'),
    grossMarginPaise: toSafe(netSales - cost, 'Gross margin'),
    schemeReceivedPaise: received,
    schemeExpectedPaise: expected,
    creditCostPaise: toSafe(creditCost, 'Credit cost'),
    loyaltyPaise: toSafe(sums.loyalty, 'Loyalty'),
    painterPointsPaise: toSafe(sums.painter, 'Painter points'),
    contributionPaise,
    marginBps: marginBps(contributionPaise, netSalesPaise),
  };
}

/** The brand's scheme money spread over its slices: by cost, else net sales, else evenly. */
function spread(amount: number, slices: readonly Sums[]): number[] {
  const byCost = slices.map((s) => toSafe(maxBig(s.cost - s.returned, 0n), 'Weight'));
  const bySales = slices.map((s) => toSafe(maxBig(s.invoiced - s.credited, 0n), 'Weight'));
  const weights = [byCost, bySales].find((w) => w.some((x) => x > 0)) ?? slices.map(() => 1);
  return allocateProportionally(amount, weights);
}

/** Contribution per brand (and product and store, as grouped) for the period's rows. */
export function brandMargins(
  rows: readonly MarginRow[],
  schemes: readonly BrandSchemeMoney[],
  options: MarginOptions,
): MarginSlice[] {
  assertNonNegative(options.costOfMoneyBps, 'Cost of money');
  const costOfMoney = BigInt(options.costOfMoneyBps);
  const byProduct = options.groupBy.includes('product');
  const byStore = options.groupBy.includes('store');

  // brand → slice key → sums, in a stable order.
  const brands = new Map<
    string,
    Map<string, { productId: string | null; storeId: string | null; sums: Sums }>
  >();
  const brandSlices = (brandId: string) => {
    let slices = brands.get(brandId);
    if (slices === undefined) {
      slices = new Map();
      brands.set(brandId, slices);
    }
    return slices;
  };
  for (const row of rows) {
    assertRow(row);
    const productId = byProduct ? row.productId : null;
    const storeId = byStore ? row.storeId : null;
    const slices = brandSlices(row.brandId);
    const key = JSON.stringify([productId, storeId]);
    const slice = slices.get(key) ?? { productId, storeId, sums: { ...ZERO } };
    const s = slice.sums;
    s.invoiced += BigInt(row.invoicedPaise);
    s.credited += BigInt(row.creditNotePaise);
    s.cost += BigInt(row.costOfSalesPaise);
    s.returned += BigInt(row.costReturnedPaise);
    s.paiseDays += BigInt(row.creditPaiseDays);
    s.loyalty += BigInt(row.loyaltyPaise);
    s.painter += BigInt(row.painterPointsPaise);
    slices.set(key, slice);
  }

  const money = new Map<string, { received: number; expected: number }>();
  for (const scheme of schemes) {
    assertNonNegative(scheme.receivedPaise, 'Scheme received');
    assertNonNegative(scheme.expectedPaise, 'Scheme expected');
    const known = money.get(scheme.brandId) ?? { received: 0, expected: 0 };
    money.set(scheme.brandId, {
      received: toSafe(BigInt(known.received) + BigInt(scheme.receivedPaise), 'Scheme received'),
      expected: toSafe(BigInt(known.expected) + BigInt(scheme.expectedPaise), 'Scheme expected'),
    });
    // A brand with scheme money but no sales still shows, as one unsplit slice.
    const slices = brandSlices(scheme.brandId);
    if (slices.size === 0) {
      slices.set('null', { productId: null, storeId: null, sums: { ...ZERO } });
    }
  }

  const result: MarginSlice[] = [];
  for (const [brandId, slices] of brands) {
    const list = [...slices.values()];
    const scheme = money.get(brandId) ?? { received: 0, expected: 0 };
    const sums = list.map((slice) => slice.sums);
    const received = spread(scheme.received, sums);
    const expected = spread(scheme.expected, sums);
    list.forEach((slice, index) => {
      result.push({
        brandId,
        productId: slice.productId,
        storeId: slice.storeId,
        ...figures(slice.sums, at(received, index), at(expected, index), costOfMoney),
      });
    });
  }
  const order = (value: string | null) => value ?? '';
  return result.sort(
    (a, b) =>
      a.brandId.localeCompare(b.brandId) ||
      order(a.productId).localeCompare(order(b.productId)) ||
      order(a.storeId).localeCompare(order(b.storeId)),
  );
}

/** Slices summed (a brand's, or every brand's): each figure the sum, the margin recomputed. */
export function sumMargins(slices: readonly MarginFigures[]): MarginFigures {
  const sum = (pick: (slice: MarginFigures) => number) =>
    toSafe(
      slices.reduce((total, slice) => total + BigInt(pick(slice)), 0n),
      'Total',
    );
  const netSalesPaise = sum((s) => s.netSalesPaise);
  const contributionPaise = sum((s) => s.contributionPaise);
  return {
    invoicedPaise: sum((s) => s.invoicedPaise),
    creditNotePaise: sum((s) => s.creditNotePaise),
    netSalesPaise,
    costPaise: sum((s) => s.costPaise),
    grossMarginPaise: sum((s) => s.grossMarginPaise),
    schemeReceivedPaise: sum((s) => s.schemeReceivedPaise),
    schemeExpectedPaise: sum((s) => s.schemeExpectedPaise),
    creditCostPaise: sum((s) => s.creditCostPaise),
    loyaltyPaise: sum((s) => s.loyaltyPaise),
    painterPointsPaise: sum((s) => s.painterPointsPaise),
    contributionPaise,
    marginBps: marginBps(contributionPaise, netSalesPaise),
  };
}

/** An amount outstanding from one day until another (null: still at the period's end). */
export interface OutstandingSpan {
  readonly amountPaise: number;
  /** The first day it was owed (the invoice date, or due date if credit days are free). */
  readonly fromOn: string;
  /** The day it was paid: not owed from then on. */
  readonly paidOn: string | null;
}

/**
 * Σ amount × days owed within the period (both ends included), the credit
 * cost's base: average outstanding × days, or sales × average days of credit.
 */
export function paiseDays(
  spans: readonly OutstandingSpan[],
  startsOn: string,
  endsOn: string,
): number {
  const start = BigInt(dayNumber(startsOn));
  const end = BigInt(dayNumber(endsOn)) + 1n;
  let total = 0n;
  for (const span of spans) {
    assertNonNegative(span.amountPaise, 'Outstanding amount');
    const from = maxBig(BigInt(dayNumber(span.fromOn)), start);
    const to = minBig(span.paidOn === null ? end : BigInt(dayNumber(span.paidOn)), end);
    if (to > from) total += BigInt(span.amountPaise) * (to - from);
  }
  return toSafe(total, 'Paise-days');
}
