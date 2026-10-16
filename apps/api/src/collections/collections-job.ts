import { schema, withTenant, type Database, type Transaction } from '@paint/db';
import { formatINR, promiseKept, reminderTemplate } from '@paint/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { indiaToday } from '../credit/credit-lookups.js';
import { canMessage, queueMessage } from '../messaging/outbox.js';
import type { Notifier } from '../notifications/notifier.js';
import { createLink, planLink, reusableLink } from '../payment-links/links.js';
import type { PaymentLinkGateways } from '../payment-links/payment-link-gateways.js';
import { PROMISE, paidTowards } from './promises.js';

const {
  collectionEscalations,
  collectionRuns,
  customerProfiles,
  organizations,
  parties,
  promisesToPay,
  reminderSchedules,
} = schema;

/** Businesses run per pass of the daily job; the next pass takes the rest. */
const DAILY_BATCH = 200;
const COLLECTIONS_LOCK = sql`hashtext('paint:collections')`;

export interface CollectionsRun {
  readonly kept: number;
  readonly broken: number;
  readonly remindersQueued: number;
}

/**
 * The daily collections run for one business, in its tenant transaction (spec
 * §6.1, rules CO-3 – CO-8): settles open promises (kept once payments cover them;
 * broken when their date has passed without, with an escalation to the people who
 * can act), then queues the reminders its schedule asks for today. One run per
 * business per India day, recorded in collection_runs; null when another server
 * holds the lock or today's run is already recorded.
 */
export async function runCollections(
  tx: Transaction,
  notifier: Notifier,
  organizationId: string,
  /** Payment links for reminders; null (off) sends reminders without one. */
  links: PaymentLinkGateways | null = null,
): Promise<CollectionsRun | null> {
  const [lock] = (
    await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(${COLLECTIONS_LOCK}, hashtext(${organizationId})) as locked`,
    )
  ).rows;
  if (!lock?.locked) return null;
  const [done] = await tx
    .select({ id: collectionRuns.id })
    .from(collectionRuns)
    .where(
      and(eq(collectionRuns.organizationId, organizationId), eq(collectionRuns.runOn, indiaToday)),
    );
  if (done) return null;

  const { kept, broken } = await settlePromises(tx, notifier, organizationId);
  const remindersQueued = await queueReminders(tx, organizationId, links);
  await tx
    .insert(collectionRuns)
    .values({ organizationId, keptCount: kept, brokenCount: broken, remindersQueued });
  return { kept, broken, remindersQueued };
}

async function settlePromises(
  tx: Transaction,
  notifier: Notifier,
  organizationId: string,
): Promise<{ kept: number; broken: number }> {
  // Explicit business filters as well as row-level security: the worker's own rule.
  const open = await tx
    .select({
      id: promisesToPay.id,
      partyId: promisesToPay.partyId,
      partyName: parties.displayName,
      homeStoreId: parties.homeStoreId,
      salespersonId: customerProfiles.assignedMemberId,
      amountPaise: promisesToPay.amountPaise,
      promisedOn: promisesToPay.promisedOn,
      due: sql<boolean>`${promisesToPay.promisedOn} < ${indiaToday}`,
      paidPaise: paidTowards(PROMISE, sql`least(promises_to_pay.promised_on, ${indiaToday})`),
    })
    .from(promisesToPay)
    .innerJoin(parties, eq(parties.id, promisesToPay.partyId))
    .leftJoin(customerProfiles, eq(customerProfiles.partyId, promisesToPay.partyId))
    .where(and(eq(promisesToPay.organizationId, organizationId), eq(promisesToPay.status, 'open')))
    .orderBy(asc(promisesToPay.promisedOn), asc(promisesToPay.id));

  let kept = 0;
  let broken = 0;
  for (const promise of open) {
    const isKept = promiseKept(promise.amountPaise, promise.paidPaise);
    // A promise still running stays open until it is paid or its date passes.
    if (!isKept && !promise.due) continue;
    await tx
      .update(promisesToPay)
      .set({
        status: isKept ? 'kept' : 'broken',
        paidPaise: promise.paidPaise,
        closedAt: sql`now()`,
      })
      .where(
        and(eq(promisesToPay.organizationId, organizationId), eq(promisesToPay.id, promise.id)),
      );
    if (isKept) {
      kept += 1;
      continue;
    }
    broken += 1;
    const notice = {
      organizationId,
      event: 'promise_broken' as const,
      title: `Promise broken: ${promise.partyName}`,
      body: `${formatINR(promise.amountPaise)} was promised by ${promise.promisedOn}; ${formatINR(promise.paidPaise)} came in.`,
      link: `/parties/${promise.partyId}/ledger`,
    };
    // The salesperson's branch managers, and who approves credit at the party's store.
    const managers =
      promise.salespersonId === null
        ? []
        : await branchManagersOf(tx, organizationId, promise.salespersonId);
    const told =
      (managers.length === 0
        ? 0
        : await notifier.notify(tx, { ...notice, to: { memberIds: managers } })) +
      (await notifier.notify(tx, {
        ...notice,
        to: { storeId: promise.homeStoreId, permission: 'credit:approve' },
      }));
    await tx.insert(collectionEscalations).values({
      organizationId,
      partyId: promise.partyId,
      promiseId: promise.id,
      notifiedCount: told,
    });
  }
  return { kept, broken };
}

/** Active branch managers who work at one of the member's stores. */
async function branchManagersOf(
  tx: Transaction,
  organizationId: string,
  memberId: string,
): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select distinct m.id from organization_members m
    join roles r on r.id = m.role_id and r.key = 'branch_manager'
    join member_stores ms on ms.member_id = m.id
    where m.organization_id = ${organizationId} and m.is_active and m.id <> ${memberId}
      and ms.store_id in (select store_id from member_stores where member_id = ${memberId})
    order by m.id`);
  return rows.rows.map((row) => row.id);
}

/**
 * Queues today's reminders (rule CO-6): for each active schedule, the bills whose
 * due date is `offset_days` before today with something still owed, one message per
 * party and channel per day, summing its bills; never while the party has an open
 * promise not yet due (CO-7), and only with consent (MSG-1). Opening balances are
 * left out until [CA-7] says when they fall due. With a payment-link provider, each
 * reminder carries a UPI link for its bills (rule PL-12): one per party and day,
 * shared by its channels, made only when a channel would send, and an open link for
 * the same bills and amount is sent again instead of a new one.
 */
async function queueReminders(
  tx: Transaction,
  organizationId: string,
  links: PaymentLinkGateways | null,
): Promise<number> {
  const schedules = await tx
    .select({ offsetDays: reminderSchedules.offsetDays, channels: reminderSchedules.channels })
    .from(reminderSchedules)
    .where(
      and(
        eq(reminderSchedules.organizationId, organizationId),
        eq(reminderSchedules.isActive, true),
      ),
    )
    // Overdue reminders first: on a day two schedules meet, the firmer one goes.
    .orderBy(sql`${reminderSchedules.offsetDays} desc`);
  const [{ today }] = (
    await tx.execute<{ today: string }>(sql`select ${indiaToday}::text as today`)
  ).rows as [{ today: string }];
  let queued = 0;
  for (const schedule of schedules) {
    const owing = await tx.execute<{
      party_id: string;
      due_on: string;
      outstanding: string;
      document_ids: string[];
      store_id: string;
    }>(sql`
      select d.party_id, d.due_on::text,
        sum(d.total_paise - coalesce((select sum(a.amount_paise) from allocations a where a.document_id = d.id), 0)) as outstanding,
        array_agg(d.id::text order by d.issued_on, d.issued_at, d.id) as document_ids,
        coalesce(min(p.home_store_id::text), (array_agg(d.store_id::text order by d.issued_on, d.issued_at, d.id))[1]) as store_id
      from tax_documents d
      join parties p on p.id = d.party_id
      where d.organization_id = ${organizationId} and d.status = 'issued'
        and d.kind in ('invoice', 'bill_of_supply', 'debit_note')
        and d.due_on = ${today}::date - ${schedule.offsetDays}::int
        and d.total_paise > coalesce((select sum(a.amount_paise) from allocations a where a.document_id = d.id), 0)
        and not exists (
          select 1 from promises_to_pay pp
          where pp.organization_id = d.organization_id and pp.party_id = d.party_id
            and pp.status = 'open' and pp.promised_on >= ${today}::date
        )
      group by d.party_id, d.due_on
      order by d.party_id`);
    const templateKey = reminderTemplate(schedule.offsetDays);
    for (const party of owing.rows) {
      const payLinkUrl = await reminderLink(tx, links, organizationId, party, schedule.channels);
      for (const channel of schedule.channels) {
        const result = await queueMessage(tx, {
          organizationId,
          partyId: party.party_id,
          channel,
          templateKey,
          variables:
            templateKey === 'payment_reminder_due'
              ? { amount: formatINR(Number(party.outstanding)), dueOn: party.due_on }
              : {
                  amount: formatINR(Number(party.outstanding)),
                  days: String(schedule.offsetDays),
                },
          reference: { type: 'party', id: party.party_id },
          dedupeKey: `reminder:${party.party_id}:${today}:${channel}`,
          memberId: null,
          payLinkUrl,
        });
        if (result.queued) queued += 1;
      }
    }
  }
  return queued;
}

/** The UPI link a reminder carries, or null without a provider or anyone to send to. */
async function reminderLink(
  tx: Transaction,
  links: PaymentLinkGateways | null,
  organizationId: string,
  party: { party_id: string; document_ids: string[]; store_id: string },
  channels: readonly ('whatsapp' | 'sms' | 'email')[],
): Promise<string | null> {
  const provider = links === null ? null : await links.forBusiness(tx, organizationId);
  if (provider === null) return null;
  let reachable = false;
  for (const channel of channels) {
    if (await canMessage(tx, { organizationId, partyId: party.party_id, channel })) {
      reachable = true;
      break;
    }
  }
  if (!reachable) return null;
  const plan = await planLink(tx, {
    partyId: party.party_id,
    purpose: 'bills',
    documentIds: party.document_ids,
  });
  // The party's advance covers the bills: the reminder goes without a link.
  if (!plan.ok) return null;
  const link = {
    organizationId,
    partyId: party.party_id,
    storeId: party.store_id,
    purpose: 'bills' as const,
    origin: 'reminder' as const,
    targets: plan.targets,
    amountPaise: plan.amountPaise,
    memberId: null,
  };
  const id = (await reusableLink(tx, link)) ?? (await createLink(tx, provider, link));
  const [row] = (
    await tx.execute<{ url: string }>(sql`select url from payment_links where id = ${id}`)
  ).rows as [{ url: string }];
  return row.url;
}

/**
 * The daily collections run across every active business not yet run today
 * (India date, database clock), each in its own transaction. Safe to run on
 * several servers at once. Returns the promises settled and reminders queued.
 */
export async function runCollectionsForBusinesses(
  db: Database,
  notifier: Notifier,
  links: PaymentLinkGateways | null = null,
): Promise<CollectionsRun> {
  const due = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      sql`${organizations.suspendedAt} is null and not exists (
        select 1 from ${collectionRuns} r
        where r.organization_id = ${organizations.id} and r.run_on = ${indiaToday}
      )`,
    )
    .orderBy(organizations.id)
    .limit(DAILY_BATCH);
  const total = { kept: 0, broken: 0, remindersQueued: 0 };
  for (const { id } of due) {
    const run = await withTenant(db, id, (tx) => runCollections(tx, notifier, id, links));
    if (run === null) continue;
    total.kept += run.kept;
    total.broken += run.broken;
    total.remindersQueued += run.remindersQueued;
  }
  return total;
}
