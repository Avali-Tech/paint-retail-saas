import { ConflictException } from '@nestjs/common';
import { schema, withTenant, type Database, type Transaction } from '@paint/db';
import { MAX_OVERDUE_WAIVER_DAYS } from '@paint/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Notifier } from '../notifications/notifier.js';
import { fieldError } from '../tax/tax-lookups.js';
import { creditRulesOf, indiaToday, openDocumentsOf } from './credit-lookups.js';

const { creditHoldRuns, creditProfiles, organizations, salesSettings } = schema;

/** Businesses checked per pass of the nightly job; the next pass takes the rest. */
const NIGHTLY_BATCH = 200;
const HOLD_LOCK = sql`hashtext('paint:credit-hold')`;

/**
 * Releases a party's hold (MVP 3 spec §4.4), optionally waiving the overdue
 * block until a date at most 90 days ahead. The caller has checked the member
 * may release (an approver, or an approved release request).
 */
export async function releaseHold(
  tx: Transaction,
  partyId: string,
  waiveOverdueUntil: string | null,
): Promise<void> {
  if (waiveOverdueUntil !== null) {
    const result = await tx.execute<{ ok: boolean }>(
      sql`select ${waiveOverdueUntil}::date between ${indiaToday} and ${indiaToday} + ${MAX_OVERDUE_WAIVER_DAYS}::int as ok`,
    );
    if (!(result.rows[0] as { ok: boolean }).ok) {
      throw fieldError(
        'waiveOverdueUntil',
        `Waive the overdue block from today for at most ${String(MAX_OVERDUE_WAIVER_DAYS)} days`,
      );
    }
  }
  const released = await tx
    .update(creditProfiles)
    .set({
      status: 'active',
      holdReason: null,
      heldAt: null,
      heldByMemberId: null,
      holdKind: null,
      overdueWaivedUntil: waiveOverdueUntil,
      updatedAt: sql`now()`,
    })
    .where(and(eq(creditProfiles.partyId, partyId), eq(creditProfiles.status, 'on_hold')))
    .returning({ id: creditProfiles.id });
  if (released.length === 0) throw new ConflictException('This party is not on hold');
}

/**
 * The nightly overdue check for one business, in its tenant transaction (MVP 3
 * spec §4.4): every active account whose oldest open document is past its due
 * date by more than the rules allow (and not waived) goes on an automatic
 * hold, and the people who look after credit are told. One run per business
 * per India day, recorded in credit_hold_runs; returns how many were held, or
 * null when another server holds the lock or today's run is already recorded.
 */
export async function holdOverdue(
  tx: Transaction,
  notifier: Notifier,
  organizationId: string,
): Promise<number | null> {
  const [lock] = (
    await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(${HOLD_LOCK}, hashtext(${organizationId})) as locked`,
    )
  ).rows;
  if (!lock?.locked) return null;
  const [done] = await tx
    .select({ id: creditHoldRuns.id })
    .from(creditHoldRuns)
    .where(
      and(eq(creditHoldRuns.organizationId, organizationId), eq(creditHoldRuns.runOn, indiaToday)),
    );
  if (done) return null;

  const { holdAfterOverdueDays } = await creditRulesOf(tx, organizationId);
  // Explicit business filters as well as row-level security: the worker's own rule.
  const overdue = await tx.execute<{
    party_id: string;
    name: string;
    home_store_id: string | null;
    overdue_days: number;
  }>(sql`
    select p.party_id, pa.display_name as name, pa.home_store_id,
      (${indiaToday} - min(owed.due))::int as overdue_days
    from credit_profiles p
    join parties pa on pa.id = p.party_id and pa.organization_id = p.organization_id
    cross join lateral (
      select o.due_on as due from (${openDocumentsOf(sql.raw('p.party_id'))}) o
      where o.outstanding > 0
      union all
      select p.opening_overdue_since
      where exists (
        select 1 from party_ledger pl
        where pl.organization_id = p.organization_id and pl.party_id = p.party_id
          and pl.entry_type = 'opening'
          and pl.amount_paise > coalesce((select sum(a.amount_paise) from allocations a where a.party_ledger_id = pl.id), 0)
      )
    ) owed
    where p.organization_id = ${organizationId} and p.status = 'active'
      and (p.overdue_waived_until is null or p.overdue_waived_until < ${indiaToday})
    group by p.party_id, pa.display_name, pa.home_store_id
    having ${indiaToday} - min(owed.due) > ${holdAfterOverdueDays}
    order by pa.display_name, p.party_id`);

  for (const party of overdue.rows) {
    const reason = `Overdue ${String(party.overdue_days)} days (automatic)`;
    await tx
      .update(creditProfiles)
      .set({
        status: 'on_hold',
        holdKind: 'auto',
        holdReason: reason,
        heldAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(creditProfiles.organizationId, organizationId),
          eq(creditProfiles.partyId, party.party_id),
        ),
      );
    for (const permission of ['credit:manage', 'credit:approve'] as const) {
      await notifier.notify(tx, {
        organizationId,
        event: 'credit_hold_applied',
        to: { storeId: party.home_store_id, permission },
        title: `Credit on hold: ${party.name}`,
        body: `${reason}. An approver can release it, with a waiver while it is paid.`,
        link: `/parties/${party.party_id}`,
      });
    }
  }
  await tx.insert(creditHoldRuns).values({ organizationId, heldCount: overdue.rows.length });
  return overdue.rows.length;
}

/**
 * The nightly overdue check across every active business that has gone live
 * and is not yet checked today (India date, database clock), each in its own
 * transaction. Safe to run on several servers at once. Returns how many
 * accounts were put on hold.
 */
export async function holdOverdueBusinesses(db: Database, notifier: Notifier): Promise<number> {
  const due = await db
    .select({ id: organizations.id })
    .from(organizations)
    .innerJoin(salesSettings, eq(salesSettings.organizationId, organizations.id))
    .where(
      sql`${organizations.suspendedAt} is null and ${salesSettings.billingLiveOn} is not null
        and not exists (
          select 1 from ${creditHoldRuns} r
          where r.organization_id = ${organizations.id} and r.run_on = ${indiaToday}
        )`,
    )
    .orderBy(organizations.id)
    .limit(NIGHTLY_BATCH);
  let held = 0;
  for (const { id } of due) {
    held += (await withTenant(db, id, (tx) => holdOverdue(tx, notifier, id))) ?? 0;
  }
  return held;
}
