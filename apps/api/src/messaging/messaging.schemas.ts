import {
  MESSAGE_CHANNELS,
  MESSAGE_LANGUAGES,
  STAFF_CONSENT_METHODS,
  TEMPLATE_KEYS,
  CONSENT_STATES,
  type RecordConsentBody,
} from '@paint/shared';
import { z } from 'zod';

export const recordConsentSchema = z.object({
  channel: z.enum(MESSAGE_CHANNELS),
  state: z.enum(CONSENT_STATES),
  method: z.enum(STAFF_CONSENT_METHODS),
  language: z.enum(MESSAGE_LANGUAGES),
  noticeVersion: z.string().trim().min(1).max(40),
}) satisfies z.ZodType<RecordConsentBody>;
export type RecordConsentInput = z.output<typeof recordConsentSchema>;

export const messagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type MessagesQueryInput = z.output<typeof messagesQuerySchema>;

export const templateKeySchema = z.object({
  key: z.enum(TEMPLATE_KEYS),
  channel: z.enum(MESSAGE_CHANNELS),
  language: z.enum(MESSAGE_LANGUAGES),
});
export type TemplateKeyInput = z.output<typeof templateKeySchema>;

export const saveTemplateSchema = templateKeySchema.extend({
  body: z.string().trim().min(1).max(1000),
  providerTemplateName: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9_]{1,200}$/,
      'Lowercase letters, digits and _ only, as the WhatsApp provider names it',
    )
    .nullable()
    .default(null),
});
export type SaveTemplateInput = z.output<typeof saveTemplateSchema>;
