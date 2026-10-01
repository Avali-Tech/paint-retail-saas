import 'reflect-metadata';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import { canAccessStore } from '@paint/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { recordPermissions, requireRecordAccess } from '../documents/record-access.js';
import { requireSalesperson } from '../leads/crm-lookups.js';
import { recordLabel, startOfTodayIst } from './activity-records.js';
import type {
  ACTIVITY_RECORD_TYPES,
  CompleteActivityInput,
  CreateActivityInput,
  FollowUpsQuery,
  TimelineQuery,
  UpdateActivityInput,
} from './activities.schemas.js';

const { activities, organizationMembers, users } = schema;

type ActivityRow = typeof activities.$inferSelect;
type RecordType = (typeof ACTIVITY_RECORD_TYPES)[number];

const assignees = alias(organizationMembers, 'assignee');
const assigneeUsers = alias(users, 'assignee_user');
const creators = alias(organizationMembers, 'creator');
const creatorUsers = alias(users, 'creator_user');
const endOfTodayIst = sql`(${startOfTodayIst} + interval '1 day')`;
const open = and(isNull(activities.completedAt), isNull(activities.cancelledAt));

export interface ActivityView {
  readonly id: string;
  readonly record: { readonly type: RecordType; readonly id: string; readonly label: string };
  readonly type: ActivityRow['type'];
  readonly subject: string;
  readonly notes: string | null;
  readonly outcome: string | null;
  readonly status: 'scheduled' | 'done' | 'cancelled';
  readonly dueAt: string | null;
  /** Scheduled and past its time. */
  readonly overdue: boolean;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly assignedTo: { readonly memberId: string; readonly name: string };
  readonly createdBy: { readonly memberId: string; readonly name: string };
  readonly createdAt: string;
}

export interface ActivityPage {
  readonly items: ActivityView[];
  readonly total: number;
}

export interface FollowUpPage extends ActivityPage {
  /** For badges: open follow-ups due before today, and today (India time). */
  readonly counts: { readonly overdue: number; readonly today: number };
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);

@Injectable()
export class ActivitiesService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Logs something done, or schedules something to do, about a record. */
  create(auth: AuthContext, input: CreateActivityInput): Promise<ActivityView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const storeIds = await requireRecordAccess(
        tx,
        auth,
        input.recordType,
        input.recordId,
        'manage',
        'activities',
      );
      const storeId = storeIds[0] ?? null;
      if (input.assignedMemberId) {
        await this.requireAssignee(tx, input.recordType, input.assignedMemberId, storeId);
      }
      const id = await this.insert(tx, auth, {
        ...input,
        storeId,
        assignedMemberId: input.assignedMemberId ?? auth.memberId,
      });
      return this.view(tx, auth, id);
    });
  }

  /** A record's activities, latest first: its timeline. */
  timeline(auth: AuthContext, query: TimelineQuery): Promise<ActivityPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await requireRecordAccess(tx, auth, query.recordType, query.recordId, 'read', 'activities');
      const where = and(
        eq(activities.recordType, query.recordType),
        eq(activities.recordId, query.recordId),
      );
      const rows = await this.rows(tx)
        .where(where)
        .orderBy(
          desc(
            sql`coalesce(${activities.completedAt}, ${activities.cancelledAt}, ${activities.dueAt})`,
          ),
          desc(activities.createdAt),
        )
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx.select({ total: count() }).from(activities).where(where);
      return { items: rows.map((row) => this.toView(row)), total: Number(totals?.total) };
    });
  }

  /** Open follow-ups for a member (default: me), soonest first, with overdue/today counts. */
  followUps(auth: AuthContext, query: FollowUpsQuery): Promise<FollowUpPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      if (query.storeId && !canAccessStore(auth, query.storeId)) {
        throw new NotFoundException('Store not found');
      }
      const scope = and(
        open,
        isNotNull(activities.dueAt),
        eq(
          activities.assignedMemberId,
          query.assignedTo === 'me' ? auth.memberId : query.assignedTo,
        ),
        query.storeId
          ? eq(activities.storeId, query.storeId)
          : auth.allStores
            ? undefined
            : or(isNull(activities.storeId), inArray(activities.storeId, [...auth.storeIds])),
      );
      const window = {
        overdue: lt(activities.dueAt, startOfTodayIst),
        today: and(gte(activities.dueAt, startOfTodayIst), lt(activities.dueAt, endOfTodayIst)),
        upcoming: gte(activities.dueAt, endOfTodayIst),
        open: undefined,
      }[query.when];
      const where = and(scope, window);
      const rows = await this.rows(tx)
        .where(where)
        .orderBy(asc(activities.dueAt), asc(activities.createdAt))
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx
        .select({
          // The outer where is the scope; the window narrows the total only.
          total: sql<number>`count(*) filter (where ${window ?? sql`true`})::int`,
          overdue: sql<number>`count(*) filter (where ${activities.dueAt} < ${startOfTodayIst})::int`,
          today: sql<number>`count(*) filter (where ${activities.dueAt} >= ${startOfTodayIst} and ${activities.dueAt} < ${endOfTodayIst})::int`,
        })
        .from(activities)
        .where(scope);
      return {
        items: rows.map((row) => this.toView(row)),
        total: Number(totals?.total),
        counts: { overdue: Number(totals?.overdue), today: Number(totals?.today) },
      };
    });
  }

  get(auth: AuthContext, activityId: string): Promise<ActivityView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const activity = await this.load(tx, activityId);
      await requireRecordAccess(
        tx,
        auth,
        activity.recordType,
        activity.recordId,
        'read',
        'activities',
      );
      return this.view(tx, auth, activityId);
    });
  }

  update(auth: AuthContext, activityId: string, input: UpdateActivityInput): Promise<ActivityView> {
    return this.act(auth, activityId, async (tx, activity) => {
      if (input.assignedMemberId) {
        await this.requireAssignee(
          tx,
          activity.recordType,
          input.assignedMemberId,
          activity.storeId,
        );
      }
      await tx
        .update(activities)
        .set({
          ...input,
          // A new time deserves a new reminder.
          ...(input.dueAt ? { remindedAt: null } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(activities.id, activityId));
    });
  }

  /** Marks it done with what came of it, and optionally schedules the next step. */
  async complete(
    auth: AuthContext,
    activityId: string,
    input: CompleteActivityInput,
  ): Promise<{ completed: ActivityView; next: ActivityView | null }> {
    const scheduled: { nextId: string | null } = { nextId: null };
    const completed = await this.act(auth, activityId, async (tx, activity) => {
      await tx
        .update(activities)
        .set({ completedAt: sql`now()`, outcome: input.outcome, updatedAt: sql`now()` })
        .where(eq(activities.id, activityId));
      if (input.next) {
        scheduled.nextId = await this.insert(tx, auth, {
          recordType: activity.recordType,
          recordId: activity.recordId,
          storeId: activity.storeId,
          type: input.next.type,
          subject: input.next.subject ?? activity.subject,
          dueAt: input.next.dueAt,
          assignedMemberId: activity.assignedMemberId,
        });
      }
    });
    return {
      completed,
      next: scheduled.nextId ? await this.get(auth, scheduled.nextId) : null,
    };
  }

  cancel(auth: AuthContext, activityId: string): Promise<ActivityView> {
    return this.act(auth, activityId, async (tx) => {
      await tx
        .update(activities)
        .set({ cancelledAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(activities.id, activityId));
    });
  }

  // Helpers -----------------------------------------------------------------

  private async insert(
    tx: Transaction,
    auth: AuthContext,
    input: Omit<CreateActivityInput, 'assignedMemberId'> & {
      storeId: string | null;
      assignedMemberId: string;
    },
  ): Promise<string> {
    const id = crypto.randomUUID();
    await tx.insert(activities).values({
      id,
      organizationId: auth.organization.id,
      recordType: input.recordType,
      recordId: input.recordId,
      storeId: input.storeId,
      type: input.type,
      subject: input.subject,
      notes: input.notes,
      outcome: input.outcome,
      dueAt: input.dueAt,
      // Nothing to schedule: it already happened.
      completedAt: input.dueAt ? undefined : (input.completedAt ?? sql`now()`),
      assignedMemberId: input.assignedMemberId,
      createdByMemberId: auth.memberId,
    });
    return id;
  }

  /** The assignee must be able to see the record, at its store. */
  private requireAssignee(
    tx: Transaction,
    recordType: RecordType,
    memberId: string,
    storeId: string | null,
  ): Promise<void> {
    return requireSalesperson(tx, memberId, storeId, recordPermissions(recordType).read);
  }

  private async load(tx: Transaction, activityId: string, lock = false): Promise<ActivityRow> {
    const query = tx.select().from(activities).where(eq(activities.id, activityId)).$dynamic();
    const [activity] = await (lock ? query.for('update') : query);
    if (!activity) throw new NotFoundException('Activity not found');
    return activity;
  }

  /** Changes an open activity: locked, with the record's manage permission. */
  private act(
    auth: AuthContext,
    activityId: string,
    work: (tx: Transaction, activity: ActivityRow) => Promise<void>,
  ): Promise<ActivityView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const activity = await this.load(tx, activityId, true);
      await requireRecordAccess(
        tx,
        auth,
        activity.recordType,
        activity.recordId,
        'manage',
        'activities',
      );
      if (activity.completedAt) throw new ConflictException('This activity is already done');
      if (activity.cancelledAt) throw new ConflictException('This activity was cancelled');
      await work(tx, activity);
      return this.view(tx, auth, activityId);
    });
  }

  private rows(tx: Transaction) {
    return tx
      .select({
        activity: activities,
        label: recordLabel,
        assigneeName: assigneeUsers.fullName,
        creatorName: creatorUsers.fullName,
        overdue: sql<boolean>`${open} and ${activities.dueAt} < now()`,
      })
      .from(activities)
      .innerJoin(assignees, eq(assignees.id, activities.assignedMemberId))
      .innerJoin(assigneeUsers, eq(assigneeUsers.id, assignees.userId))
      .innerJoin(creators, eq(creators.id, activities.createdByMemberId))
      .innerJoin(creatorUsers, eq(creatorUsers.id, creators.userId))
      .$dynamic();
  }

  private async view(
    tx: Transaction,
    _auth: AuthContext,
    activityId: string,
  ): Promise<ActivityView> {
    const [row] = await this.rows(tx).where(eq(activities.id, activityId));
    // Only called for an activity just loaded or written in this transaction.
    return this.toView(row as Awaited<ReturnType<ActivitiesService['rows']>>[number]);
  }

  private toView(row: Awaited<ReturnType<ActivitiesService['rows']>>[number]): ActivityView {
    const { activity } = row;
    return {
      id: activity.id,
      record: { type: activity.recordType, id: activity.recordId, label: row.label },
      type: activity.type,
      subject: activity.subject,
      notes: activity.notes,
      outcome: activity.outcome,
      status: activity.completedAt ? 'done' : activity.cancelledAt ? 'cancelled' : 'scheduled',
      dueAt: iso(activity.dueAt),
      overdue: row.overdue,
      completedAt: iso(activity.completedAt),
      cancelledAt: iso(activity.cancelledAt),
      assignedTo: { memberId: activity.assignedMemberId, name: row.assigneeName },
      createdBy: { memberId: activity.createdByMemberId, name: row.creatorName },
      createdAt: activity.createdAt.toISOString(),
    };
  }
}
