import 'reflect-metadata';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import {
  AGEING_BUCKETS,
  PROMISE_MAX_DAYS,
  compareWorklist,
  formatINR,
  nextStep,
  type AgeingBucket,
  type EscalationView,
  type PromiseView,
  type ReminderScheduleView,
  type WorklistPage,
  type WorklistRow,
} from '@paint/shared';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { indiaToday } from '../billing/invoice-view.js';
import { DATABASE } from '../database/database.module.js';
import { visibleParty } from '../messaging/messaging.service.js';
import { ageBooks, ageingLookups } from '../receivables/receivables.service.js';
import { fieldError } from '../tax/tax-lookups.js';
import type {
  AcknowledgeInput,
  CancelPromiseInput,
  CreatePromiseInput,
  EscalationsQueryInput,
  ReminderSchedulesInput,
  WorklistQueryInput,
} from './collections.schemas.js';
import { promiseViews } from './promises.js';
import type { PartyInfo } from '../receivables/ageing-rows.js';

const {
  activities,
  collectionEscalations,
  organizationMembers,
  parties,
  partyBalances,
  promisesToPay,
  reminderSchedules,
  users,
} = schema;

const BUCKET_RANK = new Map<AgeingBucket, number>(AGEING_BUCKETS.map((bucket, i) => [bucket, i]));

/**
 * Collections (roadmap P2-M11, spec §6.1): promises to pay, the worklist of
 * overdue customers per salesperson, escalations of broken promises and the
 * business's reminder schedule.
 */
@Injectable()
export class CollectionsService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Records a promise to pay, with a `promise_to_pay` activity on the party's timeline. */
  createPromise(
    auth: AuthContext,
    partyId: string,
    body: CreatePromiseInput,
  ): Promise<PromiseView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await visibleParty(tx, auth, partyId);
      const today = await indiaToday(tx);
      const [window] = (
        await tx.execute<{ ok: boolean }>(
          sql`select ${body.promisedOn}::date between ${today}::date and ${today}::date + ${PROMISE_MAX_DAYS}::int as ok`,
        )
      ).rows as [{ ok: boolean }];
      if (!window.ok) {
        throw fieldError(
          'promisedOn',
          `Choose a date from today to ${String(PROMISE_MAX_DAYS)} days ahead`,
        );
      }
      const [balance] = await tx
        .select({ paise: partyBalances.balancePaise })
        .from(partyBalances)
        .where(eq(partyBalances.partyId, partyId));
      const owed = balance?.paise ?? 0;
      if (body.amountPaise > owed) {
        throw fieldError(
          'amountPaise',
          owed > 0
            ? `More than the customer owes (${formatINR(owed)})`
            : 'The customer owes nothing now',
        );
      }
      const [activity] = (await tx
        .insert(activities)
        .values({
          organizationId: auth.organization.id,
          recordType: 'party',
          recordId: partyId,
          storeId: sql`(select home_store_id from parties where id = ${partyId})`,
          type: 'promise_to_pay',
          subject: `Promised ${formatINR(body.amountPaise)} by ${body.promisedOn}`,
          notes: body.note ?? null,
          completedAt: sql`now()`,
          assignedMemberId: auth.memberId,
          createdByMemberId: auth.memberId,
        })
        .returning({ id: activities.id })) as [{ id: string }];
      // One open promise per party (unique index): the second of two at once is refused.
      const [created] = await tx
        .insert(promisesToPay)
        .values({
          organizationId: auth.organization.id,
          partyId,
          amountPaise: body.amountPaise,
          promisedOn: body.promisedOn,
          madeOn: today,
          note: body.note ?? null,
          activityId: activity.id,
          createdByMemberId: auth.memberId,
        })
        .onConflictDoNothing()
        .returning({ id: promisesToPay.id });
      if (!created) throw openPromiseConflict();
      const [view] = (await promiseViews(tx, today, sql`${promisesToPay.id} = ${created.id}`)) as [
        PromiseView,
      ];
      return view;
    });
  }

  /** A party's promises, newest first. */
  partyPromises(auth: AuthContext, partyId: string): Promise<PromiseView[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await visibleParty(tx, auth, partyId);
      return promiseViews(tx, await indiaToday(tx), sql`${promisesToPay.partyId} = ${partyId}`);
    });
  }

  /** Withdraws an open promise (e.g. recorded by mistake, or replaced), with a reason. */
  cancelPromise(
    auth: AuthContext,
    promiseId: string,
    body: CancelPromiseInput,
  ): Promise<PromiseView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const promise = await this.visiblePromise(tx, auth, promiseId);
      if (promise.status !== 'open') {
        throw new ConflictException(`This promise is already ${promise.status}`);
      }
      await tx
        .update(promisesToPay)
        .set({
          status: 'cancelled',
          cancelReason: body.reason,
          closedAt: sql`now()`,
          closedByMemberId: auth.memberId,
        })
        .where(eq(promisesToPay.id, promiseId));
      const [view] = (await promiseViews(
        tx,
        await indiaToday(tx),
        sql`${promisesToPay.id} = ${promiseId}`,
      )) as [PromiseView];
      return view;
    });
  }

  /**
   * The collections worklist (spec §6.1): customers in scope with something overdue
   * today, from the receivables ageing engine, each with its last activity, open
   * promise, open escalation and next step; escalations and due promises first, then
   * the oldest debt.
   */
  worklist(auth: AuthContext, query: WorklistQueryInput): Promise<WorklistPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const today = await indiaToday(tx);
      const salespersonId = query.salespersonId === 'me' ? auth.memberId : query.salespersonId;
      const result = await ageBooks(tx, auth, {
        asOf: today,
        ...(query.storeId === undefined ? {} : { storeId: query.storeId }),
        ...(salespersonId === undefined ? {} : { salespersonId }),
      });
      const owing = new Map<
        string,
        { outstanding: number; overdue: number; maxDays: number; oldest: AgeingBucket }
      >();
      for (const bill of result.receivables) {
        const row = owing.get(bill.partyId) ?? {
          outstanding: 0,
          overdue: 0,
          maxDays: 0,
          oldest: 'not_due' as AgeingBucket,
        };
        row.outstanding += bill.outstandingPaise;
        if (bill.daysPastDue > 0) row.overdue += bill.outstandingPaise;
        row.maxDays = Math.max(row.maxDays, bill.daysPastDue);
        if (Number(BUCKET_RANK.get(bill.bucket)) > Number(BUCKET_RANK.get(row.oldest))) {
          row.oldest = bill.bucket;
        }
        owing.set(bill.partyId, row);
      }
      const overdue = [...owing].filter(([, row]) => row.overdue > 0);
      const partyIds = overdue.map(([partyId]) => partyId);
      if (partyIds.length === 0) return { asOf: today, rows: [], total: 0, overduePaise: 0 };

      const lookups = await ageingLookups(tx, auth, result);
      const promises = await promiseViews(
        tx,
        today,
        sql`${inArray(promisesToPay.partyId, partyIds)} and ${promisesToPay.status} = 'open'`,
      );
      const escalations = await tx
        .select({ id: collectionEscalations.id, partyId: collectionEscalations.partyId })
        .from(collectionEscalations)
        .where(
          and(
            inArray(collectionEscalations.partyId, partyIds),
            isNull(collectionEscalations.acknowledgedAt),
          ),
        );
      const moment = sql<Date>`coalesce(${activities.completedAt}, ${activities.createdAt})`;
      const lastActivities = await tx
        .selectDistinctOn([activities.recordId], {
          partyId: activities.recordId,
          type: activities.type,
          subject: activities.subject,
          at: sql<string>`to_char(${moment} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        })
        .from(activities)
        .where(
          and(
            eq(activities.recordType, 'party'),
            inArray(activities.recordId, partyIds),
            isNull(activities.cancelledAt),
          ),
        )
        .orderBy(activities.recordId, desc(moment), desc(activities.id));

      // By party, so a worklist of thousands of customers is not a search per row.
      const promiseOf = new Map(promises.map((p) => [p.partyId, p]));
      const escalationOf = new Map<string, string>();
      for (const e of escalations)
        if (!escalationOf.has(e.partyId)) escalationOf.set(e.partyId, e.id);
      const activityOf = new Map(lastActivities.map((a) => [a.partyId, a]));
      const rows: WorklistRow[] = overdue.map(([partyId, row]) => {
        // Every party aged is looked up.
        const party = lookups.parties.get(partyId) as unknown as PartyInfo;
        const openPromise = promiseOf.get(partyId) ?? null;
        const openEscalationId = escalationOf.get(partyId) ?? null;
        const activity = activityOf.get(partyId);
        return {
          partyId,
          name: party.name,
          phone: party.phone,
          salesperson:
            party.salespersonId === null
              ? null
              : { id: party.salespersonId, name: String(party.salespersonName) },
          outstandingPaise: row.outstanding,
          overduePaise: row.overdue,
          maxDaysPastDue: row.maxDays,
          oldestBucket: row.oldest,
          lastActivity: activity
            ? { type: activity.type, subject: activity.subject, at: activity.at }
            : null,
          openPromise,
          openEscalationId,
          nextStep: nextStep(today, openEscalationId !== null, openPromise),
        };
      });
      rows.sort(compareWorklist);
      return {
        asOf: today,
        rows: rows.slice(query.offset, query.offset + query.limit),
        total: rows.length,
        overduePaise: rows.reduce((sum, row) => sum + row.overduePaise, 0),
      };
    });
  }

  /** Escalations of broken promises, newest first; open ones only by default. */
  escalations(auth: AuthContext, query: EscalationsQueryInput): Promise<EscalationView[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const today = await indiaToday(tx);
      const rows = await tx
        .select({
          id: collectionEscalations.id,
          partyId: parties.id,
          partyName: parties.displayName,
          homeStoreId: parties.homeStoreId,
          promiseId: collectionEscalations.promiseId,
          raisedOn: collectionEscalations.raisedOn,
          notifiedCount: collectionEscalations.notifiedCount,
          acknowledgedBy: users.fullName,
          acknowledgedAt: collectionEscalations.acknowledgedAt,
          acknowledgeNote: collectionEscalations.acknowledgeNote,
        })
        .from(collectionEscalations)
        .innerJoin(parties, eq(parties.id, collectionEscalations.partyId))
        .leftJoin(
          organizationMembers,
          eq(organizationMembers.id, collectionEscalations.acknowledgedByMemberId),
        )
        .leftJoin(users, eq(users.id, organizationMembers.userId))
        .where(query.open ? isNull(collectionEscalations.acknowledgedAt) : undefined)
        .orderBy(desc(collectionEscalations.createdAt), desc(collectionEscalations.id))
        .limit(query.limit);
      const visible = rows.filter(
        (row) => auth.allStores || row.homeStoreId === null || auth.storeIds.has(row.homeStoreId),
      );
      const promises =
        visible.length === 0
          ? []
          : await promiseViews(
              tx,
              today,
              inArray(
                promisesToPay.id,
                visible.map((row) => row.promiseId),
              ),
            );
      return visible.map((row) => ({
        id: row.id,
        party: { id: row.partyId, name: row.partyName },
        promise: promises.find((p) => p.id === row.promiseId) as unknown as PromiseView,
        raisedOn: row.raisedOn,
        notifiedCount: row.notifiedCount,
        acknowledgedBy: row.acknowledgedBy,
        acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
        acknowledgeNote: row.acknowledgeNote,
      }));
    });
  }

  /** Marks an escalation as seen and acted on, once. */
  acknowledge(auth: AuthContext, escalationId: string, body: AcknowledgeInput): Promise<void> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [escalation] = await tx
        .select({
          acknowledgedAt: collectionEscalations.acknowledgedAt,
          homeStoreId: parties.homeStoreId,
        })
        .from(collectionEscalations)
        .innerJoin(parties, eq(parties.id, collectionEscalations.partyId))
        .where(eq(collectionEscalations.id, escalationId));
      if (
        !escalation ||
        !(
          auth.allStores ||
          escalation.homeStoreId === null ||
          auth.storeIds.has(escalation.homeStoreId)
        )
      ) {
        throw new NotFoundException('Escalation not found');
      }
      if (escalation.acknowledgedAt !== null) {
        throw new ConflictException('This escalation is already acknowledged');
      }
      await tx
        .update(collectionEscalations)
        .set({
          acknowledgedByMemberId: auth.memberId,
          acknowledgedAt: sql`now()`,
          acknowledgeNote: body.note ?? null,
        })
        .where(eq(collectionEscalations.id, escalationId));
    });
  }

  reminderSchedules(auth: AuthContext): Promise<ReminderScheduleView[]> {
    return withTenant(this.connection.db, auth.organization.id, (tx) => schedulesOf(tx));
  }

  /** Replaces the business's reminder schedule (an empty list turns reminders off). */
  saveReminderSchedules(
    auth: AuthContext,
    body: ReminderSchedulesInput,
  ): Promise<ReminderScheduleView[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const offsets = body.schedules.map((schedule) => schedule.offsetDays);
      await tx
        .delete(reminderSchedules)
        .where(
          offsets.length === 0
            ? undefined
            : sql`${reminderSchedules.offsetDays} <> all(${`{${offsets.join(',')}}`}::int[])`,
        );
      for (const schedule of body.schedules) {
        await tx
          .insert(reminderSchedules)
          .values({
            organizationId: auth.organization.id,
            ...schedule,
            createdByMemberId: auth.memberId,
          })
          .onConflictDoUpdate({
            target: [reminderSchedules.organizationId, reminderSchedules.offsetDays],
            set: {
              channels: schedule.channels,
              isActive: schedule.isActive,
              updatedAt: sql`now()`,
            },
          });
      }
      return schedulesOf(tx);
    });
  }

  private async visiblePromise(tx: Transaction, auth: AuthContext, promiseId: string) {
    const [promise] = await tx
      .select({ status: promisesToPay.status, partyId: promisesToPay.partyId })
      .from(promisesToPay)
      .where(eq(promisesToPay.id, promiseId));
    if (!promise) throw new NotFoundException('Promise not found');
    await visibleParty(tx, auth, promise.partyId).catch(() => {
      throw new NotFoundException('Promise not found');
    });
    return promise;
  }
}

function openPromiseConflict(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'promise_open',
    message: 'This customer already has an open promise: cancel it to record a new one',
  });
}

async function schedulesOf(tx: Transaction): Promise<ReminderScheduleView[]> {
  return tx
    .select({
      id: reminderSchedules.id,
      offsetDays: reminderSchedules.offsetDays,
      channels: reminderSchedules.channels,
      isActive: reminderSchedules.isActive,
    })
    .from(reminderSchedules)
    .orderBy(asc(reminderSchedules.offsetDays));
}
