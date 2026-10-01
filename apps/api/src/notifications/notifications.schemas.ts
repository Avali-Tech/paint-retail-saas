import { z } from 'zod';
import { NOTIFICATION_EVENTS } from './events.js';

export const listNotificationsSchema = z.object({
  unread: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListNotificationsQuery = z.output<typeof listNotificationsSchema>;

export const preferencesSchema = z.object({
  preferences: z
    .array(z.object({ event: z.enum(NOTIFICATION_EVENTS), inApp: z.boolean(), email: z.boolean() }))
    .min(1)
    .max(NOTIFICATION_EVENTS.length)
    .refine(
      (entries) => new Set(entries.map((entry) => entry.event)).size === entries.length,
      'Each event can appear only once',
    ),
});
export type PreferencesInput = z.output<typeof preferencesSchema>;
