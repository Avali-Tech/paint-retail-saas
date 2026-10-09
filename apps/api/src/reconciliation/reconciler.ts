import {
  findAllocationMismatches,
  findPartyBalanceMismatches,
  findReservationMismatches,
  findStockMismatches,
  schema,
  withTenant,
  type Database,
  type Transaction,
} from '@paint/db';
import {
  RECONCILE_PERMISSION,
  RECONCILIATION_KINDS,
  type ReconciliationKind,
  type ReconciliationTrigger,
} from '@paint/shared';
import { sql } from 'drizzle-orm';
import type { Notifier } from '../notifications/notifier.js';

const { organizations, reconciliationFindings, reconciliationRuns } = schema;

/** Where the screen showing the latest run lives. */
export const RECONCILIATION_PATH = '/accounting/reconciliation';

/** Businesses reconciled per pass of the nightly job; the next pass takes the rest. */
const NIGHTLY_BATCH = 200;

type FindingRow = Omit<typeof reconciliationFindings.$inferInsert, 'organizationId' | 'runId'>;

const KIND_NAMES: Readonly<Record<ReconciliationKind, string>> = {
  stock_on_hand: 'Stock on hand differs from the stock ledger',
  stock_reserved: 'Stock reserved differs from open reservations',
  party_balance: 'Party balances differ from the party ledger',
  allocation: 'Allocations disagree with party balances',
};

/**
 * Every disagreement between a cached total and the rows it sums (spec §3.3,
 * §4.6), using the finders of @paint/db. In tenant scope, so only this
 * business's rows are read.
 */
export async function findMismatches(tx: Transaction): Promise<FindingRow[]> {
  const onHand = await findStockMismatches(tx);
  const reserved = await findReservationMismatches(tx);
  const balances = await findPartyBalanceMismatches(tx);
  const allocations = await findAllocationMismatches(tx);
  return [
    ...onHand.map((m) => ({
      kind: 'stock_on_hand' as const,
      storeId: m.storeId,
      variantId: m.variantId,
      recorded: m.onHand,
      expected: m.ledgerTotal,
    })),
    ...reserved.map((m) => ({
      kind: 'stock_reserved' as const,
      storeId: m.storeId,
      variantId: m.variantId,
      recorded: m.reserved,
      expected: m.openReservations,
    })),
    ...balances.map((m) => ({
      kind: 'party_balance' as const,
      partyId: m.partyId,
      recorded: m.balancePaise,
      expected: m.ledgerTotalPaise,
    })),
    ...allocations.map((m) => ({
      kind: 'allocation' as const,
      partyId: m.partyId,
      recorded: m.balancePaise,
      expected: m.outstandingPaise - m.unallocatedPaise,
      advancePaise: m.advancePaise,
      unallocatedPaise: m.unallocatedPaise,
    })),
  ];
}

export interface ReconcileRequest {
  readonly organizationId: string;
  readonly trigger: ReconciliationTrigger;
  /** Who asked, for a manual run. */
  readonly memberId?: string;
}

/**
 * Reconciles one business in the caller's tenant transaction: records a run
 * with its findings, and tells the people who look after the books when
 * anything disagrees. Returns the run's id, or null when today's nightly run
 * was already recorded (by another server).
 */
export async function reconcile(
  tx: Transaction,
  notifier: Notifier,
  request: ReconcileRequest,
): Promise<string | null> {
  const findings = await findMismatches(tx);
  const [run] = await tx
    .insert(reconciliationRuns)
    .values({
      organizationId: request.organizationId,
      trigger: request.trigger,
      requestedByMemberId: request.memberId ?? null,
      findingCount: findings.length,
    })
    .onConflictDoNothing()
    .returning({ id: reconciliationRuns.id });
  if (!run) return null;
  if (findings.length === 0) return run.id;

  await tx.insert(reconciliationFindings).values(
    findings.map((finding) => ({
      ...finding,
      organizationId: request.organizationId,
      runId: run.id,
    })),
  );
  const counted = RECONCILIATION_KINDS.flatMap((kind) => {
    const found = findings.filter((finding) => finding.kind === kind).length;
    return found > 0 ? [`${KIND_NAMES[kind]}: ${String(found)}`] : [];
  });
  await notifier.notify(tx, {
    organizationId: request.organizationId,
    event: 'reconciliation_mismatch',
    to: { storeId: null, permission: RECONCILE_PERMISSION },
    ...(request.memberId === undefined ? {} : { actorMemberId: request.memberId }),
    title: `The books are out of balance: ${String(findings.length)} finding(s)`,
    body: counted.join('\n'),
    link: RECONCILIATION_PATH,
  });
  return run.id;
}

/**
 * The nightly reconciliation, across every active business: each one not yet
 * reconciled today (India date, from the database clock) is reconciled in its
 * own transaction. Safe to run on several servers at once.
 */
export async function reconcileDueBusinesses(db: Database, notifier: Notifier): Promise<number> {
  const due = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      sql`${organizations.suspendedAt} is null and not exists (
        select 1 from ${reconciliationRuns} r
        where r.organization_id = ${organizations.id} and r.trigger = 'scheduled'
          and r.run_on = (now() at time zone 'Asia/Kolkata')::date
      )`,
    )
    .orderBy(organizations.id)
    .limit(NIGHTLY_BATCH);
  // A business another server reached first is skipped by reconcile() itself.
  for (const { id } of due) {
    await withTenant(db, id, (tx) =>
      reconcile(tx, notifier, { organizationId: id, trigger: 'scheduled' }),
    );
  }
  return due.length;
}
