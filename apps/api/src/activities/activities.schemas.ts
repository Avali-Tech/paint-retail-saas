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

export const timelineSchema = z.object({
  ...record,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type TimelineQuery = z.output<typeof timelineSchema>;

export const followUpsSchema = z.object({
  /** In India time: before today, today, after today, or every open one. */
  when: z.enum(FOLLOW_UP_WINDOWS).default('open'),
  assignedTo: z.union([z.uuid(), z.literal('me')]).default('me'),
  storeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type FollowUpsQuery = z.output<typeof followUpsSchema>;
