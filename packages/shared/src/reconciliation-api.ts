import type { Permission } from './permissions.js';

/**
 * The nightly reconciliation (MVP 2, Sell & Bill, round 6a; spec §3.3, §4.6):
 * every cached total checked against the rows it sums, as the API returns it.
 * Quantities are numbers of units; money is integer paise.
 */

/** Who may look at reconciliations and run one now. */
export const RECONCILE_PERMISSION: Permission = 'accounting:reconcile';

/**
 * What a finding is about, in the order a screen lists them: stock on hand
 * against the stock ledger, stock reserved against open reservations, a
 * party's balance against its ledger, and its allocations against its balance.
 */
export const RECONCILIATION_KINDS = [
  'stock_on_hand',
  'stock_reserved',
  'party_balance',
  'allocation',
] as const;
export type ReconciliationKind = (typeof RECONCILIATION_KINDS)[number];

/** The nightly job, or someone pressing "Run now". */
export const RECONCILIATION_TRIGGERS = ['scheduled', 'manual'] as const;
export type ReconciliationTrigger = (typeof RECONCILIATION_TRIGGERS)[number];

/** True for findings whose figures are stock quantities (the rest are paise). */
export function isStockFinding(kind: ReconciliationKind): boolean {
  return kind === 'stock_on_hand' || kind === 'stock_reserved';
}

/** One disagreement a run found. */
export interface ReconciliationFindingView {
  readonly id: string;
  readonly kind: ReconciliationKind;
  /** Stock findings: the store and the pack. */
  readonly store: { readonly id: string; readonly name: string } | null;
  readonly variant: { readonly id: string; readonly sku: string; readonly name: string } | null;
  /** Party findings: the party. */
  readonly party: { readonly id: string; readonly name: string } | null;
  /** The cached figure: on hand, reserved, or the party's balance. */
  readonly recorded: number;
  /** What its rows add up to (allocations: outstanding less money not allocated). */
  readonly expected: number;
  /** recorded − expected. */
  readonly difference: number;
  /** Allocation findings: the advance the balance holds, and money received not allocated. */
  readonly advancePaise: number | null;
  readonly unallocatedPaise: number | null;
}

/** A run, without its findings (GET /reconciliation/runs). */
export interface ReconciliationRunSummary {
  readonly id: string;
  readonly trigger: ReconciliationTrigger;
  /** India date of the run. */
  readonly runOn: string;
  readonly ranAt: string;
  /** Who pressed "Run now"; null for the nightly run. */
  readonly requestedBy: { readonly memberId: string; readonly name: string } | null;
  readonly findingCount: number;
  /** Findings by kind, every kind present. */
  readonly counts: Readonly<Record<ReconciliationKind, number>>;
}

/** A run and what it found (GET /reconciliation/runs/:id, POST /reconciliation/runs). */
export interface ReconciliationRunView extends ReconciliationRunSummary {
  readonly findings: readonly ReconciliationFindingView[];
}

/** GET /reconciliation/runs: newest first. */
export interface ReconciliationRunPage {
  readonly items: readonly ReconciliationRunSummary[];
  readonly total: number;
}

/** GET /reconciliation/latest: the newest run, or null before the first one. */
export interface LatestReconciliation {
  readonly run: ReconciliationRunView | null;
}
