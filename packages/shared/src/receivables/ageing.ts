import { assertPaise, type Paise } from '../money.js';
import { addDays, dayNumber } from './dates.js';

/**
 * Receivables ageing (roadmap P2-M10, spec §1.3 and §4.6): a pure query over what a
 * party owes and what it has paid ahead, never a second ledger. Exact in paise.
 *
 * - What is owed (a `Receivable`): an issued invoice, bill of supply or debit note, an
 *   opening balance, or a charge (a bounced cheque's fee). It is aged from its due date.
 * - What was paid ahead (a `Credit`): money received, or a credit note, not yet
 *   allocated to anything. It is not aged; it lowers the party's net balance.
 * - outstanding(d) = total(d) − Σ allocations to d, as of a date (spec §4.6).
 *
 * Every allocation carries the date it took effect, so the same rows age as of any day:
 * as of a day after every entry, Σ outstanding − Σ unapplied = the party's balance and
 * Σ unapplied = its advance; as of an earlier day, the same holds for the ledger summed
 * to that day, provided each allocation's date is on or after both of its ends.
 */

/** How late an amount is on the as-of date. "0–30" counts from the due date itself. */
export const AGEING_BUCKETS = [
  'not_due',
  'days_0_30',
  'days_31_60',
  'days_61_90',
  'days_90_plus',
] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

/** The last day past due each bucket holds; the 90+ bucket holds the rest. */
const BUCKET_LIMITS: readonly [AgeingBucket, number][] = [
  ['not_due', -1],
  ['days_0_30', 30],
  ['days_31_60', 60],
  ['days_61_90', 90],
];

export type ReceivableKind = 'invoice' | 'bill_of_supply' | 'debit_note' | 'opening' | 'charge';
export type CreditKind = 'payment' | 'credit_note';

/** An amount on a date: an allocation (negative when it undoes one) and when it took effect. */
export interface DatedAmount {
  readonly on: string;
  readonly amountPaise: Paise;
}

/** Something a party owes. */
export interface Receivable {
  readonly id: string;
  readonly kind: ReceivableKind;
  readonly partyId: string;
  readonly storeId: string | null;
  readonly number: string | null;
  /** The India date it was raised: its ledger entry's date. */
  readonly raisedOn: string;
  /** When it falls due; null means the day it was raised. */
  readonly dueOn: string | null;
  readonly totalPaise: Paise;
  /** A cancelled invoice is owed no more from this date (its cancellation entry's date). */
  readonly cancelledOn: string | null;
  readonly allocations: readonly DatedAmount[];
}

/** Money a party paid, or was credited, that can be allocated to what it owes. */
export interface Credit {
  readonly id: string;
  readonly kind: CreditKind;
  readonly partyId: string;
  readonly storeId: string | null;
  readonly number: string | null;
  /** The India date it counts from: the payment's or the note's ledger entry date. */
  readonly receivedOn: string;
  readonly amountPaise: Paise;
  /** A bounced cheque counts no more from its bounce date. */
  readonly voidedOn: string | null;
  /** Its allocations to bills and to refunds paid out of it. */
  readonly allocations: readonly DatedAmount[];
}

export interface AgedReceivable extends Receivable {
  /** The due date used: `dueOn`, else the day it was raised. */
  readonly effectiveDueOn: string;
  readonly outstandingPaise: Paise;
  /** Days from the due date to the as-of date; negative while not yet due. */
  readonly daysPastDue: number;
  readonly bucket: AgeingBucket;
}

export interface UnappliedCredit extends Credit {
  readonly unappliedPaise: Paise;
}

export interface AgeingTotals {
  /** Outstanding per bucket. */
  readonly buckets: Readonly<Record<AgeingBucket, Paise>>;
  /** Σ buckets: everything still owed on bills. */
  readonly outstandingPaise: Paise;
  /** Money paid ahead and not yet allocated (advances, unused credit notes). */
  readonly unappliedPaise: Paise;
  /** outstanding − unapplied: the balance, as the party ledger has it. */
  readonly netPaise: Paise;
}

export interface AgeingResult {
  readonly asOf: string;
  /** Bills with money outstanding on the as-of date, oldest due first. */
  readonly receivables: readonly AgedReceivable[];
  /** Credits with money not yet allocated on the as-of date, oldest first. */
  readonly credits: readonly UnappliedCredit[];
  readonly totals: AgeingTotals;
}

/** The bucket for an amount `daysPastDue` days past its due date. */
export function bucketFor(daysPastDue: number): AgeingBucket {
  for (const [bucket, limit] of BUCKET_LIMITS) {
    if (daysPastDue <= limit) return bucket;
  }
  return 'days_90_plus';
}

/** Σ amounts that took effect on or before `asOf`. */
function allocatedBy(allocations: readonly DatedAmount[], asOf: number): Paise {
  let total = 0;
  for (const allocation of allocations) {
    assertPaise(allocation.amountPaise);
    if (dayNumber(allocation.on) <= asOf) total += allocation.amountPaise;
  }
  return total;
}

/** What an amount was worth on `asOf`: nothing before it began or after it ended. */
function liveAmount(amount: Paise, from: string, until: string | null, asOf: number): Paise {
  assertPaise(amount);
  const started = dayNumber(from) <= asOf;
  const ended = until !== null && dayNumber(until) <= asOf;
  return started && !ended ? amount : 0;
}

/** What is still owed on `receivable` on `asOf` (spec §4.6: total − Σ allocations). */
export function outstandingOn(receivable: Receivable, asOf: string): Paise {
  const day = dayNumber(asOf);
  const owed = liveAmount(receivable.totalPaise, receivable.raisedOn, receivable.cancelledOn, day);
  const outstanding = owed - allocatedBy(receivable.allocations, day);
  assertPaise(outstanding);
  return outstanding;
}

/** What of `credit` is not yet allocated on `asOf`. */
export function unappliedOn(credit: Credit, asOf: string): Paise {
  const day = dayNumber(asOf);
  const amount = liveAmount(credit.amountPaise, credit.receivedOn, credit.voidedOn, day);
  const unapplied = amount - allocatedBy(credit.allocations, day);
  assertPaise(unapplied);
  return unapplied;
}

/** Totals with every amount at zero. */
export function emptyTotals(): AgeingTotals {
  return {
    buckets: { not_due: 0, days_0_30: 0, days_31_60: 0, days_61_90: 0, days_90_plus: 0 },
    outstandingPaise: 0,
    unappliedPaise: 0,
    netPaise: 0,
  };
}

/** `totals` with more outstanding in `bucket` and more unapplied credit. */
function addTo(
  totals: AgeingTotals,
  bucket: AgeingBucket | null,
  outstanding: Paise,
  unapplied: Paise,
): AgeingTotals {
  const buckets =
    bucket === null
      ? totals.buckets
      : { ...totals.buckets, [bucket]: totals.buckets[bucket] + outstanding };
  const outstandingPaise = totals.outstandingPaise + outstanding;
  const unappliedPaise = totals.unappliedPaise + unapplied;
  return { buckets, outstandingPaise, unappliedPaise, netPaise: outstandingPaise - unappliedPaise };
}

/** Adds two sets of totals. */
export function sumTotals(a: AgeingTotals, b: AgeingTotals): AgeingTotals {
  let total = addTo(a, null, 0, b.unappliedPaise);
  for (const bucket of AGEING_BUCKETS) total = addTo(total, bucket, b.buckets[bucket], 0);
  return total;
}

const byDue = (a: AgedReceivable, b: AgedReceivable) =>
  a.daysPastDue === b.daysPastDue
    ? a.raisedOn.localeCompare(b.raisedOn) || a.id.localeCompare(b.id)
    : b.daysPastDue - a.daysPastDue;

const byReceived = (a: Credit, b: Credit) =>
  a.receivedOn.localeCompare(b.receivedOn) || a.id.localeCompare(b.id);

/**
 * Ages what is owed and paid ahead as of `asOf`: each bill's outstanding amount and
 * bucket, each credit's unapplied amount, and the totals. Bills and credits with
 * nothing left on that day are left out.
 */
export function ageReceivables(input: {
  readonly asOf: string;
  readonly receivables: readonly Receivable[];
  readonly credits: readonly Credit[];
}): AgeingResult {
  const asOfDay = dayNumber(input.asOf);
  let totals = emptyTotals();
  const receivables: AgedReceivable[] = [];
  for (const receivable of input.receivables) {
    const outstandingPaise = outstandingOn(receivable, input.asOf);
    if (outstandingPaise === 0) continue;
    const effectiveDueOn = receivable.dueOn ?? receivable.raisedOn;
    const daysPastDue = asOfDay - dayNumber(effectiveDueOn);
    const bucket = bucketFor(daysPastDue);
    receivables.push({ ...receivable, effectiveDueOn, outstandingPaise, daysPastDue, bucket });
    totals = addTo(totals, bucket, outstandingPaise, 0);
  }
  const credits: UnappliedCredit[] = [];
  for (const credit of input.credits) {
    const unappliedPaise = unappliedOn(credit, input.asOf);
    if (unappliedPaise === 0) continue;
    credits.push({ ...credit, unappliedPaise });
    totals = addTo(totals, null, 0, unappliedPaise);
  }
  assertPaise(totals.netPaise);
  return {
    asOf: input.asOf,
    receivables: receivables.sort(byDue),
    credits: credits.sort(byReceived),
    totals,
  };
}

/**
 * The result's totals per group, e.g. per party, salesperson or store. `receivableKey`
 * and `creditKey` name each item's group; groups come back in first-seen order.
 */
export function groupAgeing<K>(
  result: AgeingResult,
  receivableKey: (receivable: AgedReceivable) => K,
  creditKey: (credit: UnappliedCredit) => K,
): Map<K, AgeingTotals> {
  const groups = new Map<K, AgeingTotals>();
  const add = (key: K, bucket: AgeingBucket | null, outstanding: Paise, unapplied: Paise) => {
    groups.set(key, addTo(groups.get(key) ?? emptyTotals(), bucket, outstanding, unapplied));
  };
  for (const receivable of result.receivables) {
    add(receivableKey(receivable), receivable.bucket, receivable.outstandingPaise, 0);
  }
  for (const credit of result.credits) add(creditKey(credit), null, 0, credit.unappliedPaise);
  return groups;
}

/** The days a receivables dashboard looks ahead for "due this week": today and six more. */
export const DUE_SOON_DAYS = 7;

export interface DueSummary {
  /** Outstanding falling due on the as-of date. */
  readonly dueTodayPaise: Paise;
  /** Outstanding falling due from the as-of date through the next six days. */
  readonly dueThisWeekPaise: Paise;
  /** Outstanding whose due date is before the as-of date. */
  readonly overduePaise: Paise;
}

/** What falls due today and this week, and what is overdue (roadmap P2-M10 dashboard). */
export function dueSummary(result: AgeingResult): DueSummary {
  const weekEnd = addDays(result.asOf, DUE_SOON_DAYS - 1);
  let dueTodayPaise = 0;
  let dueThisWeekPaise = 0;
  let overduePaise = 0;
  for (const receivable of result.receivables) {
    const amount = receivable.outstandingPaise;
    if (receivable.daysPastDue > 0) overduePaise += amount;
    else if (receivable.effectiveDueOn <= weekEnd) {
      dueThisWeekPaise += amount;
      if (receivable.daysPastDue === 0) dueTodayPaise += amount;
    }
  }
  return { dueTodayPaise, dueThisWeekPaise, overduePaise };
}

/** A party's credit limit beside what it owes, for credit utilisation. */
export interface CreditLine {
  readonly limitPaise: Paise;
  /** The party's net balance; an advance (negative) uses none of the limit. */
  readonly netPaise: Paise;
}

export interface CreditUtilisation {
  /** Σ limits of the parties given credit. */
  readonly limitPaise: Paise;
  /** Σ what those parties owe (net, never below zero each). */
  readonly usedPaise: Paise;
  /** used ÷ limit in basis points (10000 = 100 %), rounded half up; null without limits. */
  readonly utilisationBps: number | null;
  /** Parties owing more than their limit. */
  readonly overLimit: number;
}

/** How much of the credit given is in use, across parties with a limit above zero. */
export function creditUtilisation(lines: readonly CreditLine[]): CreditUtilisation {
  let limitPaise = 0;
  let usedPaise = 0;
  let overLimit = 0;
  for (const line of lines) {
    assertPaise(line.limitPaise);
    assertPaise(line.netPaise);
    if (line.limitPaise <= 0) continue;
    const used = Math.max(line.netPaise, 0);
    limitPaise += line.limitPaise;
    usedPaise += used;
    if (used > line.limitPaise) overLimit += 1;
  }
  assertPaise(limitPaise);
  assertPaise(usedPaise);
  // BigInt: used × 10000 can pass 2^53 for a very large business.
  const utilisationBps =
    limitPaise === 0
      ? null
      : Number((BigInt(usedPaise) * 20_000n + BigInt(limitPaise)) / (2n * BigInt(limitPaise)));
  return { limitPaise, usedPaise, utilisationBps, overLimit };
}
