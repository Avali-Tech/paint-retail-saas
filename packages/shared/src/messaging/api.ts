import type { Permission } from '../permissions.js';
import type { ConsentMethod, ConsentState } from './consent.js';
import type { MessageChannel, MessageLanguage, TemplateKey } from './templates.js';

/** Reading a party's consent and messages; recording consent. */
export const MESSAGING_READ_PERMISSION = 'parties:read' as const satisfies Permission;
export const CONSENT_MANAGE_PERMISSION = 'parties:manage' as const satisfies Permission;
/** Rewording the business's message templates. */
export const TEMPLATES_MANAGE_PERMISSION = 'organization:manage' as const satisfies Permission;

export const MESSAGE_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'skipped',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** What the server can send on (GET /messaging/status). */
export interface MessagingStatus {
  /** The WhatsApp provider ("log", or a BSP later), or null when none is configured. */
  readonly whatsapp: string | null;
  readonly sms: boolean;
  readonly email: boolean;
}

export interface ConsentView {
  readonly id: string;
  readonly channel: MessageChannel;
  readonly address: string;
  readonly state: ConsentState;
  readonly method: ConsentMethod;
  readonly noticeVersion: string;
  readonly language: MessageLanguage;
  readonly recordedBy: string | null;
  readonly recordedAt: string;
}

/** A party's consent: the current record per channel and the history, newest first. */
export interface PartyConsentsView {
  readonly current: readonly ConsentView[];
  readonly history: readonly ConsentView[];
  /** Where messages would go now: the party's mobile and email. */
  readonly phone: string | null;
  readonly email: string | null;
}

export interface RecordConsentBody {
  readonly channel: MessageChannel;
  readonly state: ConsentState;
  readonly method: 'counter_with_notice' | 'signed_form' | 'web_form';
  readonly language: MessageLanguage;
  readonly noticeVersion: string;
}

export interface MessageView {
  readonly id: string;
  readonly channel: MessageChannel;
  readonly templateKey: TemplateKey;
  readonly language: MessageLanguage;
  readonly toAddress: string;
  readonly body: string;
  readonly status: MessageStatus;
  readonly skipReason: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly sentAt: string | null;
}

/** Whether a message was queued, and why not when it was not. */
export type QueueResult =
  | { readonly queued: true; readonly messageId: string }
  | { readonly queued: false; readonly reason: 'no_consent' | 'no_address' | 'duplicate' };

/** One template for one channel and language, as the business sends it. */
export interface TemplateView {
  readonly key: TemplateKey;
  readonly channel: MessageChannel;
  readonly language: MessageLanguage;
  readonly body: string;
  readonly variables: readonly string[];
  /** True when the business has reworded it. */
  readonly custom: boolean;
  readonly providerTemplateName: string | null;
}
