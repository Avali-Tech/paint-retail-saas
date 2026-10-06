import 'reflect-metadata';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import { canAccessStore } from '@paint/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { withinIndiaDays } from '../common/india-days.js';
import { DATABASE } from '../database/database.module.js';
import {
  recordPermissions,
  requireRecordAccess,
  visibleRecords,
} from '../documents/record-access.js';
import { requireSalesperson } from '../leads/crm-lookups.js';
import { recordLabel, startOfTodayIst } from './activity-records.js';
import {
  ACTIVITY_RECORD_TYPES,
  type CompleteActivityInput,
  type CreateActivityInput,
  type FollowUpsQuery,
  type TimelineQuery,
  type UpdateActivityInput,
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
/** When it happened or is due: done, cancelled, else its due time, else when it was logged. */
const moment = sql`coalesce(${activities.completedAt}, ${activities.cancelledAt}, ${activities.dueAt}, ${activities.createdAt})`;

/**
 * Open follow-ups on records the member can see: one member's, or (null)
 * everyone's; at one store, or wherever the member works.
 */
export function followUpScope(
  auth: AuthContext,
  assignee: string | null,
  storeId: string | undefined,
): SQL | undefined {
  return and(
    open,
    isNotNull(activities.dueAt),
    assignee === null ? undefined : eq(activities.assignedMemberId, assignee),
    storeId ? eq(activities.storeId, storeId) : undefined,
    visibleRecords(auth, activities.recordType, activities.recordId, ACTIVITY_RECORD_TYPES),
  );
}

/**
 * How many follow-ups in the scope there are (within the window, if given),
 * and how many are due before today and today (India time).
 */
export async function countFollowUps(
  tx: Transaction,
  scope: SQL | undefined,
  window?: SQL,
): Promise<{ total: number; overdue: number; today: number }> {
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
    total: Number(totals?.total),
    overdue: Number(totals?.overdue),
    today: Number(totals?.today),
  };
}

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

  /**
   * A record's activities, latest first: its timeline. Without a record, the
   * activities on every record the member can see (of one record type, if given).
   */
  timeline(auth: AuthContext, query: TimelineQuery): Promise<ActivityPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const { recordType, recordId } = query;
      let records: SQL | undefined;
      if (recordType && recordId) {
        await requireRecordAccess(tx, auth, recordType, recordId, 'read', 'activities');
        records = and(eq(activities.recordType, recordType), eq(activities.recordId, recordId));
      } else {
        records = visibleRecords(
          auth,
          activities.recordType,
          activities.recordId,
          recordType ? [recordType] : ACTIVITY_RECORD_TYPES,
        );
      }
      const person = query.person === 'me' ? auth.memberId : query.person;
      const where = and(
        records,
        query.type ? eq(activities.type, query.type) : undefined,
        person
          ? or(eq(activities.assignedMemberId, person), eq(activities.createdByMemberId, person))
          : undefined,
        withinIndiaDays(moment, query.from, query.to),
      );
      const rows = await this.rows(tx)
        .where(where)
        .orderBy(desc(moment), desc(activities.createdAt), desc(activities.id))
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx.select({ total: count() }).from(activities).where(where);
      return { items: rows.map((row) => this.toView(row)), total: Number(totals?.total) };
    });
  }

  /**
   * Open follow-ups, soonest first, with overdue/today counts: mine (the
   * default), another member's, or everyone's (for members who see the team).
   */
  followUps(auth: AuthContext, query: FollowUpsQuery): Promise<FollowUpPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      if (query.storeId && !canAccessStore(auth, query.storeId)) {
        throw new NotFoundException('Store not found');
      }
      if (query.assignedTo === 'everyone' && !auth.permissions.has('members:read')) {
        throw new ForbiddenException('Only members who can see the team see everyone’s follow-ups');
      }
      const assignee =
        query.assignedTo === 'everyone'
          ? null
          : query.assignedTo === 'me'
            ? auth.memberId
            : query.assignedTo;
      const scope = followUpScope(auth, assignee, query.storeId);
      const window = {
        overdue: lt(activities.dueAt, startOfTodayIst),
        today: and(gte(activities.dueAt, startOfTodayIst), lt(activities.dueAt, endOfTodayIst)),
        upcoming: gte(activities.dueAt, endOfTodayIst),
        open: undefined,
      }[query.when];
      const rows = await this.rows(tx)
        .where(and(scope, window))
        .orderBy(asc(activities.dueAt), asc(activities.createdAt), asc(activities.id))
        .limit(query.limit)
        .offset(query.offset);
      const { total, overdue, today } = await countFollowUps(tx, scope, window);
      return { items: rows.map((row) => this.toView(row)), total, counts: { overdue, today } };
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
