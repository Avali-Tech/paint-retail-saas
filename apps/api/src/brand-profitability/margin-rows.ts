import { nextAverageCost } from '@paint/db';
import {
  allocateProportionally,
  earnInvoice,
  lineMillilitres,
  paiseDays,
  ruleInForce,
  toEarnRule,
  weighLines,
  type DatedAmount,
  type EarnLine,
  type MarginRow,
  type OutstandingSpan,
} from '@paint/shared';

/**
 * The rows brand profitability feeds the margin engine (`brandMargins`, spec §6.3):
 * one per brand, product and store, from the books as loaded by
 * `profitability-data.ts`. Pure, so every attribution rule is tested here:
 *
 * - **Net sales**: taxable value of the period's issued invoices, bills of supply
 *   and debit notes (an undercharge put right is a sale), less its credit notes.
 * - **Cost**: units invoiced × the store's average cost of the product when the
 *   invoice was issued, replayed from the stock ledger exactly as stock posting
 *   keeps it; less the units a credit note put back on the shelf (returned less
 *   written off as damaged) × the average cost on the note's day, the value they
 *   re-entered stock at. Units sold with no average cost yet count at zero, and
 *   are counted so the screen can say so.
 * - **Credit cost**: each bill's paise-days outstanding within the period, from
 *   the day it was raised until each allocation took effect (as ageing dates
 *   them), spread over its lines by line total (outstanding includes the GST).
 *   Every bill owed during the period counts, whenever it was raised, so the
 *   period carries the cost of the money its days tied up ([PO-34]).
 * - **Loyalty and painter points**: the points each period document earned or
 *   took back, valued at the point value, spread over its lines: the bill-to
 *   party's by taxable value (it earns on taxable value), the painter's by what
 *   each line earns under the rules of the invoice's date (as take-backs weigh
 *   them, spec §6.5). Entries on accounts of the document's own party are the
 *   bill-to's; any other account named is its influencer's.
 */

export type SaleKind = 'invoice' | 'bill_of_supply' | 'debit_note' | 'credit_note';

/** A line of a sale document issued (or since cancelled) in the period. */
export interface PeriodLine {
  readonly documentId: string;
  readonly kind: SaleKind;
  /** Cancelled documents only weigh their own points: no sales, no cost. */
  readonly cancelled: boolean;
  readonly storeId: string;
  readonly issuedOn: string;
  /** When it was issued, in microseconds since 1970 (the stock ledger's clock). */
  readonly issuedAt: bigint;
  readonly lineId: string;
  readonly variantId: string;
  readonly productId: string;
  readonly brandId: string;
  readonly taxablePaise: number;
  readonly totalPaise: number;
  readonly quantity: number;
  readonly packSize: number;
  readonly unit: string;
  /** On a note: the issue date of the invoice it corrects. */
  readonly sourceIssuedOn: string | null;
}

/** Units of a variant a credit note moved back into stock (returned less written off). */
export interface Restock {
  readonly documentId: string;
  readonly variantId: string;
  readonly quantity: number;
}

/** A costed receipt into a store's stock of a variant, in ledger order. */
export interface CostedMove {
  readonly storeId: string;
  readonly variantId: string;
  readonly at: bigint;
  readonly quantity: number;
  readonly unitCostPaise: number;
  /** On hand just before it. */
  readonly onHandBefore: number;
}

/** A bill customers owed on at some time in the period, with its lines. */
export interface CreditBill {
  readonly id: string;
  readonly storeId: string;
  readonly raisedOn: string;
  readonly totalPaise: number;
  readonly cancelledOn: string | null;
  /** Each allocation against it (negative to undo), dated when it took effect. */
  readonly allocations: readonly DatedAmount[];
  readonly lines: readonly {
    readonly productId: string;
    readonly brandId: string;
    readonly totalPaise: number;
  }[];
}

/** Points a period document earned or took back, by whose account. */
export interface DocumentPoints {
  readonly documentId: string;
  readonly holder: 'customer' | 'painter';
  readonly points: number;
}

/** A stored painter earn rule. */
export interface StoredEarnRule {
  readonly id: string;
  readonly basis: 'value' | 'litre';
  readonly points: number;
  readonly perPaise: number | null;
  readonly perMillilitres: number | null;
  readonly brandId: string | null;
  readonly multiplierBps: number;
  readonly isActive: boolean;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

export interface MarginInputs {
  readonly lines: readonly PeriodLine[];
  readonly restocks: readonly Restock[];
  readonly costedMoves: readonly CostedMove[];
  readonly bills: readonly CreditBill[];
  readonly points: readonly DocumentPoints[];
  readonly rules: readonly StoredEarnRule[];
}

export interface MarginSettings {
  readonly from: string;
  readonly to: string;
  readonly pointValuePaise: number;
}

/** A margin row, with the invoice lines it sold that had no average cost (counted at 0). */
export interface ProfitabilityRow extends MarginRow {
  readonly uncostedLines: number;
}

const MILLI = 1000n;
const toMilli = (quantity: number) => BigInt(Math.round(quantity * 1000));

/** A pair's key in the maps below. */
const pairKey = (storeId: string, variantId: string) => `${storeId}:${variantId}`;

/**
 * The average cost per unit (paise) of a store's variant after each costed receipt,
 * replayed with stock posting's own formula; `at` answers it for any moment.
 */
export function averageCosts(moves: readonly CostedMove[]) {
  const steps = new Map<string, { at: bigint; cost: bigint }[]>();
  for (const move of moves) {
    const key = pairKey(move.storeId, move.variantId);
    const list = steps.get(key) ?? [];
    const previous = list.at(-1)?.cost ?? null;
    list.push({
      at: move.at,
      cost: nextAverageCost(
        toMilli(move.onHandBefore),
        previous,
        toMilli(move.quantity),
        BigInt(move.unitCostPaise),
      ),
    });
    steps.set(key, list);
  }
  return {
    /** The average cost at `at` (receipts at that moment included); null before any. */
    at(storeId: string, variantId: string, at: bigint): bigint | null {
      const list = steps.get(pairKey(storeId, variantId)) ?? [];
      let low = 0;
      let high = list.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if ((list[middle] as { at: bigint }).at <= at) low = middle + 1;
        else high = middle;
      }
      return low === 0 ? null : (list[low - 1] as { cost: bigint }).cost;
    },
  };
}

/** What a bill was owed, from when to when: one span per stretch of a constant amount. */
export function outstandingSpans(bill: CreditBill): OutstandingSpan[] {
  const changes = new Map<string, number>();
  for (const allocation of bill.allocations) {
    changes.set(allocation.on, (changes.get(allocation.on) ?? 0) + allocation.amountPaise);
  }
  const days = [...changes].sort(([a], [b]) => a.localeCompare(b));
  const end = bill.cancelledOn;
  const spans: OutstandingSpan[] = [];
  let owed = bill.totalPaise;
  let since = bill.raisedOn;
  for (const [day, change] of days) {
    if (end !== null && day >= end) break;
    if (day > since) {
      if (owed > 0) spans.push({ amountPaise: owed, fromOn: since, paidOn: day });
      since = day;
    }
    owed -= change;
  }
  if (owed > 0) spans.push({ amountPaise: owed, fromOn: since, paidOn: end });
  return spans;
}

/** Each item paired with the value in the same place. */
function zip<A, B>(left: readonly A[], right: readonly B[]): [A, B][] {
  const values = right.values();
  return left.map((item) => [item, values.next().value as B]);
}

/** `items` paired with their part of `amount`, split by `weights` as {@link spread} does. */
function shares<T>(amount: number, items: readonly T[], weights: readonly bigint[]) {
  return zip(items, spread(amount, weights));
}

/** Weights as safe numbers, scaled down together when a bigint would not fit. */
function safeWeights(weights: readonly bigint[]): number[] {
  const largest = weights.reduce((max, weight) => (weight > max ? weight : max), 0n);
  let shift = 0n;
  while (largest >> shift > BigInt(Number.MAX_SAFE_INTEGER)) shift += 1n;
  return weights.map((weight) => Number(weight >> shift));
}

/**
 * `amount` (either sign) spread over `weights` with the largest remainder first,
 * so the parts add up exactly; evenly when every weight is 0.
 */
export function spread(amount: number, weights: readonly bigint[]): number[] {
  const numbers = safeWeights(weights);
  const usable = numbers.some((weight) => weight > 0) ? numbers : numbers.map(() => 1);
  const parts = allocateProportionally(Math.abs(amount), usable);
  return amount < 0 ? parts.map((part) => -part) : parts;
}

interface Sums {
  brandId: string;
  productId: string;
  storeId: string;
  invoiced: number;
  credited: number;
  costMilli: bigint;
  returnedMilli: bigint;
  paiseDays: number;
  loyalty: number;
  painter: number;
  uncosted: number;
}

/** Half up, from thousandths of a paisa to paise. */
const roundMilli = (milli: bigint) => Number((milli + MILLI / 2n) / MILLI);

/** The painter weights of a document's lines, under the rules of the invoice's date. */
function painterWeights(
  lines: readonly [PeriodLine, ...PeriodLine[]],
  rules: readonly StoredEarnRule[],
): bigint[] {
  const [first] = lines;
  const day = first.sourceIssuedOn ?? first.issuedOn;
  const earnLines: EarnLine[] = lines.map((line) => ({
    key: line.lineId,
    brandId: line.brandId,
    taxablePaise: line.taxablePaise,
    millilitres: lineMillilitres(line.quantity, line.packSize, line.unit),
  }));
  const inForce = rules.filter((rule) => ruleInForce(rule, day)).map(toEarnRule);
  return weighLines(earnLines, earnInvoice(earnLines, inForce)).map((line) => line.weight);
}

/** Every brand, product and store's figures for the period. */
export function marginRows(input: MarginInputs, settings: MarginSettings): ProfitabilityRow[] {
  const sums = new Map<string, Sums>();
  const at = (brandId: string, productId: string, storeId: string): Sums => {
    const key = `${brandId}|${productId}|${storeId}`;
    let entry = sums.get(key);
    if (entry === undefined) {
      entry = {
        brandId,
        productId,
        storeId,
        invoiced: 0,
        credited: 0,
        costMilli: 0n,
        returnedMilli: 0n,
        paiseDays: 0,
        loyalty: 0,
        painter: 0,
        uncosted: 0,
      };
      sums.set(key, entry);
    }
    return entry;
  };
  const costs = averageCosts(input.costedMoves);
  const byDocument = new Map<string, PeriodLine[]>();
  for (const line of input.lines) {
    const list = byDocument.get(line.documentId) ?? [];
    list.push(line);
    byDocument.set(line.documentId, list);
  }

  // Sales and the cost of the units invoiced.
  for (const line of input.lines) {
    if (line.cancelled) continue;
    const row = at(line.brandId, line.productId, line.storeId);
    if (line.kind === 'credit_note') {
      row.credited += line.taxablePaise;
      continue;
    }
    row.invoiced += line.taxablePaise;
    if (line.kind === 'debit_note') continue;
    const cost = costs.at(line.storeId, line.variantId, line.issuedAt);
    if (cost === null) row.uncosted += 1;
    else row.costMilli += toMilli(line.quantity) * cost;
  }

  // Units back on the shelf, at the average cost on the note's day.
  for (const restock of input.restocks) {
    const line = byDocument
      .get(restock.documentId)
      ?.find((candidate) => candidate.variantId === restock.variantId);
    if (line === undefined || restock.quantity <= 0) continue;
    const cost = costs.at(line.storeId, line.variantId, line.issuedAt) ?? 0n;
    at(line.brandId, line.productId, line.storeId).returnedMilli +=
      toMilli(restock.quantity) * cost;
  }

  // Credit cost: each bill's paise-days in the period, by line total.
  for (const bill of input.bills) {
    const days = paiseDays(outstandingSpans(bill), settings.from, settings.to);
    if (days === 0 || bill.lines.length === 0) continue;
    for (const [line, part] of shares(
      days,
      bill.lines,
      bill.lines.map((line) => BigInt(line.totalPaise)),
    )) {
      at(line.brandId, line.productId, bill.storeId).paiseDays += part;
    }
  }

  // Points, valued and spread over the lines that earned them.
  for (const entry of input.points) {
    const lines = byDocument.get(entry.documentId);
    if (lines === undefined || entry.points === 0) continue;
    const customer = entry.holder === 'customer';
    const weights = customer
      ? lines.map((line) => BigInt(line.taxablePaise))
      : painterWeights(lines as [PeriodLine, ...PeriodLine[]], input.rules);
    for (const [line, part] of shares(entry.points * settings.pointValuePaise, lines, weights)) {
      const row = at(line.brandId, line.productId, line.storeId);
      if (customer) row.loyalty += part;
      else row.painter += part;
    }
  }

  return [...sums.values()].map((row): ProfitabilityRow => ({
    brandId: row.brandId,
    productId: row.productId,
    storeId: row.storeId,
    invoicedPaise: row.invoiced,
    creditNotePaise: row.credited,
    costOfSalesPaise: roundMilli(row.costMilli),
    costReturnedPaise: roundMilli(row.returnedMilli),
    creditPaiseDays: row.paiseDays,
    // More taken back in the period than earned here counts as none ([PO-82]).
    loyaltyPaise: Math.max(row.loyalty, 0),
    painterPointsPaise: Math.max(row.painter, 0),
    uncostedLines: row.uncosted,
  }));
}
