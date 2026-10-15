import {
  creditUtilisation,
  dueSummary,
  emptyTotals,
  sumTotals,
  type AgeingBucket,
  type AgeingGroup,
  type AgeingResult,
  type AgeingRowView,
  type AgeingTotals,
  type ReceivablesSummaryView,
} from '@paint/shared';

/** What a row shows of a party. */
export interface PartyInfo {
  readonly name: string;
  readonly phone: string | null;
  readonly salespersonId: string | null;
  readonly salespersonName: string | null;
  /** The credit limit when the party has credit, else null. */
  readonly limitPaise: number | null;
}

export interface StoreInfo {
  readonly name: string;
  readonly code: string;
}

export interface AgeingLookups {
  /** Every party in the result, and every credit customer in scope (for utilisation). */
  readonly parties: ReadonlyMap<string, PartyInfo>;
  readonly stores: ReadonlyMap<string, StoreInfo>;
}

/** Customers shown on the receivables dashboard. */
export const TOP_CUSTOMERS = 5;

/** A party of the result; a missing one is a programming error. */
export function partyOf(lookups: AgeingLookups, partyId: string): PartyInfo {
  const party = lookups.parties.get(partyId);
  if (!party) throw new Error(`Party ${partyId} missing from the lookups`);
  return party;
}

/** A store of the result, or null for none (an opening balance) or one no longer found. */
export function storeOf(lookups: AgeingLookups, storeId: string | null): StoreInfo | null {
  return storeId === null ? null : (lookups.stores.get(storeId) ?? null);
}

type RowDetails = Pick<AgeingRowView, 'id' | 'name' | 'code' | 'phone' | 'limitPaise'>;

interface Group {
  readonly details: RowDetails;
  readonly parties: Set<string>;
  late: number | null;
  totals: AgeingTotals;
}

/** Totals holding one amount: outstanding in `bucket`, or (no bucket) unapplied credit. */
function single(bucket: AgeingBucket | null, amount: number): AgeingTotals {
  const empty = emptyTotals();
  return bucket === null
    ? { ...empty, unappliedPaise: amount, netPaise: -amount }
    : {
        ...empty,
        buckets: { ...empty.buckets, [bucket]: amount },
        outstandingPaise: amount,
        netPaise: amount,
      };
}

/** Sorts rows without a name (no salesperson, no store) first among equal balances. */
const nameKey = (row: AgeingRowView) => row.name ?? '';

/**
 * The ageing table's rows (roadmap P2-M10): the result grouped by customer, by the
 * salesperson who looks after the customer, or by the store of each bill and payment.
 * Largest net amount first, then by name.
 */
export function ageingRows(
  result: AgeingResult,
  groupBy: AgeingGroup,
  lookups: AgeingLookups,
): AgeingRowView[] {
  const detailsOf = (partyId: string, storeId: string | null): RowDetails => {
    const none = { code: null, phone: null, limitPaise: null };
    if (groupBy === 'customer') {
      const party = partyOf(lookups, partyId);
      return {
        ...none,
        id: partyId,
        name: party.name,
        phone: party.phone,
        limitPaise: party.limitPaise,
      };
    }
    if (groupBy === 'store') {
      const store = storeOf(lookups, storeId);
      return { ...none, id: storeId, name: store?.name ?? null, code: store?.code ?? null };
    }
    const party = partyOf(lookups, partyId);
    return { ...none, id: party.salespersonId, name: party.salespersonName };
  };
  const groups = new Map<string | null, Group>();
  const enter = (partyId: string, storeId: string | null): Group => {
    const details = detailsOf(partyId, storeId);
    let group = groups.get(details.id);
    if (group === undefined) {
      group = { details, parties: new Set(), late: null, totals: emptyTotals() };
      groups.set(details.id, group);
    }
    group.parties.add(partyId);
    return group;
  };
  for (const receivable of result.receivables) {
    const group = enter(receivable.partyId, receivable.storeId);
    group.totals = sumTotals(group.totals, single(receivable.bucket, receivable.outstandingPaise));
    if (receivable.daysPastDue >= 0) {
      group.late = Math.max(group.late ?? 0, receivable.daysPastDue);
    }
  }
  for (const credit of result.credits) {
    const group = enter(credit.partyId, credit.storeId);
    group.totals = sumTotals(group.totals, single(null, credit.unappliedPaise));
  }
  return [...groups.values()]
    .map((group): AgeingRowView => ({
      ...group.details,
      customers: group.parties.size,
      maxDaysPastDue: group.late,
      totals: group.totals,
    }))
    .sort(
      (a, b) =>
        b.totals.netPaise - a.totals.netPaise ||
        nameKey(a).localeCompare(nameKey(b)) ||
        String(a.id).localeCompare(String(b.id)),
    );
}

/** The receivables dashboard's figures (roadmap P2-M10), from one ageing result. */
export function receivablesSummary(
  result: AgeingResult,
  lookups: AgeingLookups,
): ReceivablesSummaryView {
  const customers = ageingRows(result, 'customer', lookups);
  const nets = new Map(customers.map((row) => [row.id, row.totals.netPaise]));
  const overdue = new Map<string, number>();
  for (const receivable of result.receivables) {
    if (receivable.daysPastDue <= 0) continue;
    overdue.set(
      receivable.partyId,
      (overdue.get(receivable.partyId) ?? 0) + receivable.outstandingPaise,
    );
  }
  const credit = creditUtilisation(
    [...lookups.parties].flatMap(([partyId, party]) =>
      party.limitPaise === null
        ? []
        : [{ limitPaise: party.limitPaise, netPaise: nets.get(partyId) ?? 0 }],
    ),
  );
  return {
    asOf: result.asOf,
    totals: result.totals,
    ...dueSummary(result),
    customers: customers.filter((row) => row.totals.outstandingPaise > 0).length,
    credit,
    topCustomers: customers
      .filter((row) => row.totals.netPaise > 0)
      .slice(0, TOP_CUSTOMERS)
      .map((row) => {
        // Customer rows always name their party.
        const partyId = String(row.id);
        return {
          partyId,
          name: String(row.name),
          phone: row.phone,
          netPaise: row.totals.netPaise,
          overduePaise: overdue.get(partyId) ?? 0,
          maxDaysPastDue: row.maxDaysPastDue,
        };
      }),
  };
}
