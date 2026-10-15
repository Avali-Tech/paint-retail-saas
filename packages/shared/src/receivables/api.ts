import type { PartyLedgerEntryKind } from '../billing-api.js';
import type { Permission } from '../permissions.js';
import type { AgeingTotals, CreditUtilisation, DueSummary, ReceivableKind } from './ageing.js';

// The receivables and statement API (roadmap P2-M10, P2-M12). Amounts in paise.

/**
 * Who sees receivables: the people who see credit. A dedicated `receivables:read`
 * would need a data migration to grant it to existing roles, so it waits for one.
 */
export const RECEIVABLES_PERMISSION = 'credit:read' as const satisfies Permission;
/** Who prints a party's statement: the people who see its ledger (GET /parties/:id/ledger). */
export const STATEMENT_PERMISSION = 'sales:read' as const satisfies Permission;
/** Entries one statement prints at most; a longer period is refused (pick a shorter one). */
export const STATEMENT_MAX_ENTRIES = 5_000;

/** How an ageing table is grouped. */
export const AGEING_GROUPS = ['customer', 'salesperson', 'store'] as const;
export type AgeingGroup = (typeof AGEING_GROUPS)[number];

/** Filters every receivables figure accepts. */
export interface ReceivablesQuery {
  /** The day to age as of (India date); today when left out. */
  readonly asOf?: string;
  /** Only bills and payments of this store. */
  readonly storeId?: string;
  /** Only customers this member looks after; "none" for customers nobody does. */
  readonly salespersonId?: string;
}

/** GET /receivables/ageing. */
export interface AgeingQuery extends ReceivablesQuery {
  readonly groupBy?: AgeingGroup;
  /** Customer name or mobile (customer grouping). */
  readonly q?: string;
  /** Only rows with something past due. */
  readonly overdueOnly?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

/** One row of an ageing table: a customer, a salesperson or a store. */
export interface AgeingRowView {
  /** The party, member or store; null for "not assigned" or "no store" (an opening balance). */
  readonly id: string | null;
  readonly name: string | null;
  /** The store code (store grouping). */
  readonly code: string | null;
  /** The customer's mobile (customer grouping). */
  readonly phone: string | null;
  /** The customer's credit limit, when it has credit (customer grouping). */
  readonly limitPaise: number | null;
  /** Customers in the row (always 1 for a customer). */
  readonly customers: number;
  /** The most days any of its bills is past due; null when nothing is due yet. */
  readonly maxDaysPastDue: number | null;
  readonly totals: AgeingTotals;
}

export interface AgeingPage {
  readonly asOf: string;
  readonly groupBy: AgeingGroup;
  /** Largest net amount first. */
  readonly rows: AgeingRowView[];
  /** Every row that matches, not only this page. */
  readonly totals: AgeingTotals;
  /** Rows that match. */
  readonly total: number;
}

export interface TopCustomerView {
  readonly partyId: string;
  readonly name: string;
  readonly phone: string | null;
  readonly netPaise: number;
  readonly overduePaise: number;
  readonly maxDaysPastDue: number | null;
}

/** GET /receivables/summary: the receivables dashboard (roadmap P2-M10). */
export interface ReceivablesSummaryView extends DueSummary {
  readonly asOf: string;
  readonly totals: AgeingTotals;
  /** Customers owing something on the as-of date. */
  readonly customers: number;
  readonly credit: CreditUtilisation;
  /** Who owes most, largest first (at most 5). */
  readonly topCustomers: TopCustomerView[];
}

/** GET /parties/:id/statement and /statement.pdf. */
export interface StatementQuery {
  readonly from: string;
  readonly to: string;
}

/** One ledger entry in a statement. */
export interface StatementEntryView {
  readonly entryOn: string;
  readonly entryType: PartyLedgerEntryKind;
  readonly referenceNumber: string | null;
  readonly note: string | null;
  /** Positive: the party owes more. */
  readonly amountPaise: number;
  /** The balance after this entry. */
  readonly balancePaise: number;
}

/** A bill with money still due at the statement's end. */
export interface OpenItemView {
  readonly kind: ReceivableKind;
  readonly number: string | null;
  readonly raisedOn: string;
  readonly dueOn: string;
  readonly outstandingPaise: number;
  readonly daysPastDue: number;
}

/**
 * A party's statement for a period (roadmap P2-M12, spec §1.3): the party ledger
 * between two dates with its opening and closing balance, and the ageing on the last
 * day. closing − opening = Σ entries; ageing.netPaise = closing.
 */
export interface StatementData {
  readonly business: {
    readonly name: string;
    readonly legalName: string | null;
    /** The party's home store when it is GST-registered, else null. */
    readonly gstin: string | null;
    readonly address: string | null;
  };
  readonly party: {
    readonly id: string;
    readonly name: string;
    readonly phone: string | null;
    readonly gstin: string | null;
    readonly address: string | null;
  };
  readonly from: string;
  readonly to: string;
  /** The India date it was produced on. */
  readonly generatedOn: string;
  readonly openingPaise: number;
  readonly entries: StatementEntryView[];
  readonly debitsPaise: number;
  readonly creditsPaise: number;
  readonly closingPaise: number;
  /** Aged as of `to`. */
  readonly ageing: AgeingTotals;
  /** Bills with money due on `to`, most overdue first. */
  readonly openItems: OpenItemView[];
}
