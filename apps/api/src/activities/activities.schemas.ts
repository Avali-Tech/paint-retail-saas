import { schema } from '@paint/db';
import { z } from 'zod';

export const ACTIVITY_TYPES = schema.activityType.enumValues;
export const ACTIVITY_RECORD_TYPES = schema.activityRecordType.enumValues;
export const FOLLOW_UP_WINDOWS = ['overdue', 'today', 'upcoming', 'open'] as const;

const subject = z.string().trim().min(2).max(200);
const longText = z.string().trim().min(1).max(4000);
/** A moment with its time zone, e.g. 2026-10-02T11:00:00+05:30. */
const moment = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const record = { recordType: z.enum(ACTIVITY_RECORD_TYPES), recordId: z.uuid() };

/**
 * Without dueAt the activity is logged as done (now, or at completedAt);
 * with dueAt it is scheduled.
 */
export const createActivitySchema = z
  .object({
    ...record,
    type: z.enum(ACTIVITY_TYPES),
    subject,
    notes: longText.optional(),
    outcome: longText.optional(),
    dueAt: moment.optional(),
    completedAt: moment.optional(),
    /** Defaults to whoever adds it. */
    assignedMemberId: z.uuid().optional(),
  })
  .refine((body) => body.dueAt === undefined || body.completedAt === undefined, {
    path: ['completedAt'],
    message: 'Leave out dueAt to log something already done',
  })
  .refine((body) => body.dueAt === undefined || body.outcome === undefined, {
    path: ['outcome'],
    message: 'Add the outcome when you complete it',
  });
export type CreateActivityInput = z.output<typeof createActivitySchema>;

export const updateActivitySchema = z
  .object({
    subject: subject.optional(),
    notes: longText.nullable().optional(),
    dueAt: moment.optional(),
    assignedMemberId: z.uuid().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type UpdateActivityInput = z.output<typeof updateActivitySchema>;

export const completeActivitySchema = z.object({
  outcome: longText.optional(),
  /** Schedules the next step at the same time. */
  next: z
    .object({
      dueAt: moment,
      subject: subject.optional(),
      type: z.enum(ACTIVITY_TYPES).default('follow_up'),
    })
    .optional(),
});
export type CompleteActivityInput = z.output<typeof completeActivitySchema>;

const member = z.union([z.uuid(), z.literal('me')]);
const day = z.iso.date();

/**
 * One record's timeline (recordType and recordId), or, without a record,
 * activities across every record the member can see (optionally of one record
 * type). Filters apply to both.
 */
export const timelineSchema = z
  .object({
    recordType: z.enum(ACTIVITY_RECORD_TYPES).optional(),
    recordId: z.uuid().optional(),
    type: z.enum(ACTIVITY_TYPES).optional(),
    /** Whoever is assigned it or logged it: a member id or "me". */
    person: member.optional(),
    /** India-time days, inclusive, of when it happened or is due. */
    from: day.optional(),
    to: day.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((query) => query.recordId === undefined || query.recordType !== undefined, {
    path: ['recordType'],
    message: 'Give the record type with the record id',
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    path: ['to'],
    message: 'The “to” date cannot be before the “from” date',
  });
export type TimelineQuery = z.output<typeof timelineSchema>;

export const followUpsSchema = z.object({
  /** In India time: before today, today, after today, or every open one. */
  when: z.enum(FOLLOW_UP_WINDOWS).default('open'),
  /** A member, me, or (for managers) everyone's at the member's stores. */
  assignedTo: z.union([member, z.literal('everyone')]).default('me'),
  storeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type FollowUpsQuery = z.output<typeof followUpsSchema>;
