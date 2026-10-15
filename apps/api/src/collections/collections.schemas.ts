import {
  MESSAGE_CHANNELS,
  REMINDER_OFFSET_MAX,
  REMINDER_OFFSET_MIN,
  type CreatePromiseBody,
} from '@paint/shared';
import { z } from 'zod';

const isoDate = z.iso.date('Use a date like 2026-10-20');

export const createPromiseSchema = z.object({
  amountPaise: z.number().int().positive().max(1_000_000_000_00),
  promisedOn: isoDate,
  note: z.string().trim().min(1).max(1000).optional(),
}) satisfies z.ZodType<CreatePromiseBody>;
export type CreatePromiseInput = z.output<typeof createPromiseSchema>;

export const cancelPromiseSchema = z.object({ reason: z.string().trim().min(1).max(500) });
export type CancelPromiseInput = z.output<typeof cancelPromiseSchema>;

export const worklistQuerySchema = z.object({
  /** A member, "none" (nobody looks after them) or "me". */
  salespersonId: z.union([z.uuid(), z.enum(['none', 'me'])]).optional(),
  storeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type WorklistQueryInput = z.output<typeof worklistQuerySchema>;

export const escalationsQuerySchema = z.object({
  open: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type EscalationsQueryInput = z.output<typeof escalationsQuerySchema>;

export const acknowledgeSchema = z.object({ note: z.string().trim().min(1).max(1000).optional() });
export type AcknowledgeInput = z.output<typeof acknowledgeSchema>;

export const reminderSchedulesSchema = z
  .object({
    schedules: z
      .array(
        z.object({
          offsetDays: z.number().int().min(REMINDER_OFFSET_MIN).max(REMINDER_OFFSET_MAX),
          channels: z
            .array(z.enum(MESSAGE_CHANNELS))
            .min(1, 'Choose at least one channel')
            .refine((channels) => new Set(channels).size === channels.length, 'Each channel once'),
          isActive: z.boolean().default(true),
        }),
      )
      .max(10),
  })
  .refine(
    (body) => new Set(body.schedules.map((s) => s.offsetDays)).size === body.schedules.length,
    { message: 'One reminder per day', path: ['schedules'] },
  );
export type ReminderSchedulesInput = z.output<typeof reminderSchedulesSchema>;
