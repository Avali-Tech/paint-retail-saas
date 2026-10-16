import { schema, type Database, type Transaction } from '@paint/db';
import {
  DEFAULT_TEMPLATES,
  TEMPLATE_VARIABLES,
  consentFor,
  emailParts,
  payLinkText,
  renderTemplate,
  type ConsentRecord,
  type MessageChannel,
  type MessageLanguage,
  type QueueResult,
  type TemplateKey,
} from '@paint/shared';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import type { SmsSender } from '../auth/sms.js';
import type { EmailSender } from '../notifications/email-sender.js';
import type { MessagingProvider } from './messaging-provider.js';

const { messageOutbox, messageTemplates, messagingConsents, organizations, parties } = schema;

/** Give up on a message after this many failed attempts. */
export const MAX_MESSAGE_ATTEMPTS = 5;
const MESSAGE_BATCH = 50;

/** A message to queue for a party (P2-M32, the outbox pattern). */
export interface MessageToQueue {
  readonly organizationId: string;
  readonly partyId: string;
  readonly channel: MessageChannel;
  readonly templateKey: TemplateKey;
  /** The template's variables; `name` and `business` are filled when left out. */
  readonly variables: Readonly<Record<string, string>>;
  readonly reference?: { readonly type: string; readonly id: string };
  /** Queues at most one message per key (e.g. one reminder per party, channel and day). */
  readonly dedupeKey?: string;
  /** Null when the system queues it (reminders, the collections job). */
  readonly memberId: string | null;
  /**
   * A UPI payment link (round 4a): `{{payLink}}` says where to pay in the message's
   * language. Templates that take `{{payLink}}` get it empty without one.
   */
  readonly payLinkUrl?: string | null;
  /** What the link asks for, when the message names another amount ([PO-43]). */
  readonly payLinkAmount?: string | null;
}

/** The business's wording of a template on a channel in a language, else the product's. */
async function wordingOf(
  tx: Transaction,
  organizationId: string,
  key: TemplateKey,
  channel: MessageChannel,
  language: MessageLanguage,
): Promise<string> {
  const [custom] = await tx
    .select({ body: messageTemplates.body })
    .from(messageTemplates)
    .where(
      and(
        eq(messageTemplates.organizationId, organizationId),
        eq(messageTemplates.key, key),
        eq(messageTemplates.channel, channel),
        eq(messageTemplates.language, language),
        eq(messageTemplates.isActive, true),
      ),
    );
  return custom?.body ?? DEFAULT_TEMPLATES[key][language];
}

/** The variables of a message: the party's and shop's names, the caller's, and the link. */
function variablesOf(
  message: Pick<MessageToQueue, 'templateKey' | 'variables' | 'payLinkUrl' | 'payLinkAmount'>,
  names: { readonly name: string; readonly business: string },
  language: MessageLanguage,
): Record<string, string> {
  return {
    ...names,
    ...message.variables,
    ...(TEMPLATE_VARIABLES[message.templateKey].includes('payLink')
      ? {
          payLink: payLinkText(message.payLinkUrl ?? null, language, message.payLinkAmount ?? null),
        }
      : {}),
  };
}

/** The latest consent record per channel of a party, newest first. */
export async function latestConsents(
  tx: Transaction,
  organizationId: string,
  partyId: string,
): Promise<ConsentRecord[]> {
  return tx
    .selectDistinctOn([messagingConsents.channel], {
      channel: messagingConsents.channel,
      address: messagingConsents.address,
      state: messagingConsents.state,
      language: messagingConsents.language,
    })
    .from(messagingConsents)
    .where(
      and(
        eq(messagingConsents.organizationId, organizationId),
        eq(messagingConsents.partyId, partyId),
      ),
    )
    .orderBy(messagingConsents.channel, desc(messagingConsents.recordedAt));
}

/** Where a message on `channel` goes for a party now: its mobile, or its email. */
export function addressFor(
  party: { readonly phone: string | null; readonly email: string | null },
  channel: MessageChannel,
): string | null {
  return channel === 'email' ? party.email : party.phone;
}

/**
 * Queues a message in the caller's transaction, rendered in the language the party
 * consented in, from the business's wording or the product's. Nothing is queued
 * without consent for that channel at the party's current address (spec MSG-1, MSG-9;
 * [CA-3]); the worker checks consent again when it sends.
 */
export async function queueMessage(tx: Transaction, message: MessageToQueue): Promise<QueueResult> {
  const reach = await reachOf(tx, message);
  if (!reach.ok) return { queued: false, reason: reach.reason };
  const { party, address, consent } = reach;
  const variables = variablesOf(message, party, consent.language);
  const template = await wordingOf(
    tx,
    message.organizationId,
    message.templateKey,
    message.channel,
    consent.language,
  );
  const [queued] = await tx
    .insert(messageOutbox)
    .values({
      organizationId: message.organizationId,
      partyId: message.partyId,
      channel: message.channel,
      templateKey: message.templateKey,
      language: consent.language,
      toAddress: address,
      variables,
      body: renderTemplate(template, variables).slice(0, 2000),
      referenceType: message.reference?.type ?? null,
      referenceId: message.reference?.id ?? null,
      dedupeKey: message.dedupeKey ?? null,
      createdByMemberId: message.memberId,
    })
    .onConflictDoNothing({ target: [messageOutbox.organizationId, messageOutbox.dedupeKey] })
    .returning({ id: messageOutbox.id });
  return queued ? { queued: true, messageId: queued.id } : { queued: false, reason: 'duplicate' };
}

/**
 * Whether a message on `channel` would be queued for the party now: it has an address
 * and its consent there (MSG-1). The reminder run asks before it makes a payment link.
 */
export async function canMessage(
  tx: Transaction,
  target: Pick<MessageToQueue, 'organizationId' | 'partyId' | 'channel'>,
): Promise<boolean> {
  return (await reachOf(tx, target)).ok;
}

/** Where a message to the party goes and in what language, or why it cannot go. */
async function reachOf(
  tx: Transaction,
  message: Pick<MessageToQueue, 'organizationId' | 'partyId' | 'channel'>,
): Promise<
  | {
      ok: true;
      party: { name: string; business: string };
      address: string;
      consent: { language: MessageLanguage };
    }
  | { ok: false; reason: 'no_consent' | 'no_address' }
> {
  const [party] = (await tx
    .select({
      name: parties.displayName,
      phone: parties.phone,
      email: parties.email,
      business: organizations.name,
    })
    .from(parties)
    .innerJoin(organizations, eq(organizations.id, parties.organizationId))
    .where(
      and(eq(parties.organizationId, message.organizationId), eq(parties.id, message.partyId)),
    )) as [{ name: string; phone: string | null; email: string | null; business: string }];
  const address = addressFor(party, message.channel);
  if (address === null) return { ok: false, reason: 'no_address' };
  const consent = consentFor(
    await latestConsents(tx, message.organizationId, message.partyId),
    message.channel,
    address,
  );
  if (consent === null) return { ok: false, reason: 'no_consent' };
  return { ok: true, party, address, consent };
}

/**
 * A message as it would read on WhatsApp in the party's consented language (English
 * without consent), for a wa.me link a member sends by hand.
 */
export async function previewMessage(
  tx: Transaction,
  message: Omit<MessageToQueue, 'channel' | 'reference' | 'dedupeKey' | 'memberId'>,
): Promise<string> {
  const [party] = (await tx
    .select({ name: parties.displayName, business: organizations.name })
    .from(parties)
    .innerJoin(organizations, eq(organizations.id, parties.organizationId))
    .where(
      and(eq(parties.organizationId, message.organizationId), eq(parties.id, message.partyId)),
    )) as [{ name: string; business: string }];
  const consents = await latestConsents(tx, message.organizationId, message.partyId);
  const language = consents.find((consent) => consent.channel === 'whatsapp')?.language ?? 'en';
  return renderTemplate(
    await wordingOf(tx, message.organizationId, message.templateKey, 'whatsapp', language),
    variablesOf(message, party, language),
  );
}

/** Who sends on each channel; null where the channel is off. */
export interface MessageSenders {
  readonly whatsapp: MessagingProvider | null;
  readonly sms: SmsSender | null;
  readonly email: EmailSender | null;
}

export interface SendRun {
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
}

/**
 * Sends queued messages that are due, across businesses (the worker's job). Each is
 * checked again first: no consent at the party's current address now, or no sender
 * for its channel, and it is skipped. Failures are retried with growing gaps, then
 * given up. SKIP LOCKED lets several servers share the queue without sending twice.
 */
export function sendDueMessages(db: Database, senders: MessageSenders): Promise<SendRun> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(messageOutbox)
      .where(and(eq(messageOutbox.status, 'queued'), lte(messageOutbox.nextAttemptAt, sql`now()`)))
      .orderBy(asc(messageOutbox.nextAttemptAt), asc(messageOutbox.createdAt))
      .limit(MESSAGE_BATCH)
      .for('update', { skipLocked: true });
    const run = { sent: 0, failed: 0, skipped: 0 };
    for (const message of due) {
      const skip = async (reason: string) => {
        await tx
          .update(messageOutbox)
          .set({ status: 'skipped', skipReason: reason })
          .where(eq(messageOutbox.id, message.id));
        run.skipped += 1;
      };
      const [party] = (await tx
        .select({ phone: parties.phone, email: parties.email })
        .from(parties)
        .where(
          and(eq(parties.organizationId, message.organizationId), eq(parties.id, message.partyId)),
        )) as [{ phone: string | null; email: string | null }];
      const consent = consentFor(
        await latestConsents(tx, message.organizationId, message.partyId),
        message.channel,
        message.toAddress,
      );
      if (consent === null || addressFor(party, message.channel) !== message.toAddress) {
        await skip('no_consent');
        continue;
      }
      const attempts = message.attempts + 1;
      try {
        const sent = await deliver(tx, senders, message);
        if (sent === null) {
          await skip('channel_disabled');
          continue;
        }
        await tx
          .update(messageOutbox)
          .set({
            status: 'sent',
            attempts,
            provider: sent.provider,
            providerRef: sent.providerRef,
            sentAt: sql`now()`,
            lastError: null,
          })
          .where(eq(messageOutbox.id, message.id));
        run.sent += 1;
      } catch (error) {
        await tx
          .update(messageOutbox)
          .set({
            attempts,
            lastError: String(error).slice(0, 500),
            status: attempts >= MAX_MESSAGE_ATTEMPTS ? 'failed' : 'queued',
            // 2, 4, 8, 16 minutes.
            nextAttemptAt: sql`now() + make_interval(mins => ${2 ** attempts})`,
          })
          .where(eq(messageOutbox.id, message.id));
        run.failed += 1;
      }
    }
    return run;
  });
}

type QueuedMessage = typeof messageOutbox.$inferSelect;

/** Hands a message to its channel's sender; null when the channel is off. */
async function deliver(
  tx: Transaction,
  senders: MessageSenders,
  message: QueuedMessage,
): Promise<{ provider: string; providerRef: string } | null> {
  if (message.channel === 'whatsapp') {
    if (senders.whatsapp === null) return null;
    const [named] = await tx
      .select({ name: messageTemplates.providerTemplateName })
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.organizationId, message.organizationId),
          eq(messageTemplates.key, message.templateKey),
          eq(messageTemplates.channel, 'whatsapp'),
          eq(messageTemplates.language, message.language),
          eq(messageTemplates.isActive, true),
        ),
      );
    const { providerRef } = await senders.whatsapp.send({
      to: message.toAddress,
      template: { key: message.templateKey, name: named?.name ?? null, language: message.language },
      variables: message.variables,
      body: message.body,
      idempotencyKey: message.id,
    });
    return { provider: senders.whatsapp.name, providerRef };
  }
  if (message.channel === 'sms') {
    if (senders.sms === null) return null;
    await senders.sms.send(message.toAddress, message.body);
    return { provider: 'sms', providerRef: `sms-${message.id}` };
  }
  if (senders.email === null) return null;
  const { subject, text } = emailParts(message.body);
  await senders.email.send({ to: message.toAddress, subject, text });
  return { provider: 'email', providerRef: `email-${message.id}` };
}
