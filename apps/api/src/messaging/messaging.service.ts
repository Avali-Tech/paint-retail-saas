import 'reflect-metadata';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import {
  CONSENT_NOTICE_VERSION,
  DEFAULT_TEMPLATES,
  MESSAGE_CHANNELS,
  MESSAGE_LANGUAGES,
  TEMPLATE_KEYS,
  TEMPLATE_VARIABLES,
  templateProblems,
  type ConsentView,
  type MessageView,
  type MessagingStatus,
  type PartyConsentsView,
  type TemplateView,
} from '@paint/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { canSeeParty } from '../parties/party-access.js';
import { fieldError } from '../tax/tax-lookups.js';
import type {
  MessagesQueryInput,
  RecordConsentInput,
  SaveTemplateInput,
  TemplateKeyInput,
} from './messaging.schemas.js';
import { addressFor } from './outbox.js';

const { messageOutbox, messageTemplates, messagingConsents, organizationMembers, parties, users } =
  schema;

export const MESSAGING_SETTINGS = Symbol('MESSAGING_SETTINGS');

/** What the server can send on, from its configuration. */
export type MessagingSettings = MessagingStatus;

/** A party the member may see, with where messages to it would go; 404 otherwise. */
export async function visibleParty(tx: Transaction, auth: AuthContext, partyId: string) {
  const [party] = await tx
    .select({
      id: parties.id,
      name: parties.displayName,
      phone: parties.phone,
      email: parties.email,
      homeStoreId: parties.homeStoreId,
    })
    .from(parties)
    .where(eq(parties.id, partyId));
  if (!party || !canSeeParty(auth, party)) throw new NotFoundException('Customer not found');
  return party;
}

/**
 * Consent, messages and templates (roadmap P2-M32, messaging half): what staff
 * record when a party agrees to (or refuses) messages, what was sent, and the
 * business's own wording.
 */
@Injectable()
export class MessagingService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(MESSAGING_SETTINGS) private readonly settings: MessagingSettings,
  ) {}

  status(): MessagingStatus {
    return this.settings;
  }

  consents(auth: AuthContext, partyId: string): Promise<PartyConsentsView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const party = await visibleParty(tx, auth, partyId);
      const history = await tx
        .select({
          id: messagingConsents.id,
          channel: messagingConsents.channel,
          address: messagingConsents.address,
          state: messagingConsents.state,
          method: messagingConsents.method,
          noticeVersion: messagingConsents.noticeVersion,
          language: messagingConsents.language,
          recordedBy: users.fullName,
          recordedAt: messagingConsents.recordedAt,
        })
        .from(messagingConsents)
        .leftJoin(
          organizationMembers,
          eq(organizationMembers.id, messagingConsents.recordedByMemberId),
        )
        .leftJoin(users, eq(users.id, organizationMembers.userId))
        .where(eq(messagingConsents.partyId, partyId))
        .orderBy(desc(messagingConsents.recordedAt), desc(messagingConsents.id));
      const views: ConsentView[] = history.map((row) => ({
        ...row,
        recordedAt: row.recordedAt.toISOString(),
      }));
      return {
        current: MESSAGE_CHANNELS.flatMap((channel) => {
          const latest = views.find((view) => view.channel === channel);
          return latest ? [latest] : [];
        }),
        history: views,
        phone: party.phone,
        email: party.email,
      };
    });
  }

  /**
   * Records a party's consent or its withdrawal for one channel, at the party's
   * current mobile or email, after the current notice was shown (spec MSG-2).
   */
  async recordConsent(
    auth: AuthContext,
    partyId: string,
    body: RecordConsentInput,
  ): Promise<PartyConsentsView> {
    await withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const party = await visibleParty(tx, auth, partyId);
      const address = addressFor(party, body.channel);
      if (address === null) {
        throw fieldError(
          'channel',
          body.channel === 'email'
            ? 'Add the customer’s email address first'
            : 'Add the customer’s mobile number first',
        );
      }
      if (body.noticeVersion !== CONSENT_NOTICE_VERSION) {
        throw fieldError('noticeVersion', 'Show the customer the current notice, then record it');
      }
      await tx.insert(messagingConsents).values({
        organizationId: auth.organization.id,
        partyId,
        channel: body.channel,
        address,
        state: body.state,
        method: body.method,
        noticeVersion: body.noticeVersion,
        language: body.language,
        recordedByMemberId: auth.memberId,
      });
    });
    return this.consents(auth, partyId);
  }

  messages(auth: AuthContext, partyId: string, query: MessagesQueryInput): Promise<MessageView[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await visibleParty(tx, auth, partyId);
      const rows = await tx
        .select({
          id: messageOutbox.id,
          channel: messageOutbox.channel,
          templateKey: messageOutbox.templateKey,
          language: messageOutbox.language,
          toAddress: messageOutbox.toAddress,
          body: messageOutbox.body,
          status: messageOutbox.status,
          skipReason: messageOutbox.skipReason,
          attempts: messageOutbox.attempts,
          createdAt: messageOutbox.createdAt,
          sentAt: messageOutbox.sentAt,
        })
        .from(messageOutbox)
        .where(eq(messageOutbox.partyId, partyId))
        .orderBy(desc(messageOutbox.createdAt), desc(messageOutbox.id))
        .limit(query.limit);
      return rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
      }));
    });
  }

  /** Every template in every channel and language, as the business sends it. */
  templates(auth: AuthContext): Promise<TemplateView[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const custom = await tx.select().from(messageTemplates);
      const find = (key: string, channel: string, language: string) =>
        custom.find(
          (row) => row.key === key && row.channel === channel && row.language === language,
        );
      return TEMPLATE_KEYS.flatMap((key) =>
        MESSAGE_CHANNELS.flatMap((channel) =>
          MESSAGE_LANGUAGES.map((language) => {
            const own = find(key, channel, language);
            return {
              key,
              channel,
              language,
              body: own?.body ?? DEFAULT_TEMPLATES[key][language],
              variables: TEMPLATE_VARIABLES[key],
              custom: own !== undefined,
              providerTemplateName: own?.providerTemplateName ?? null,
            };
          }),
        ),
      );
    });
  }

  /** Rewords one template; its variables must be the template's own. */
  async saveTemplate(auth: AuthContext, body: SaveTemplateInput): Promise<TemplateView[]> {
    const [problem] = templateProblems(body.key, body.body);
    if (problem !== undefined) throw fieldError('body', problem);
    await withTenant(this.connection.db, auth.organization.id, (tx) =>
      tx
        .insert(messageTemplates)
        .values({ organizationId: auth.organization.id, ...body, updatedByMemberId: auth.memberId })
        .onConflictDoUpdate({
          target: [
            messageTemplates.organizationId,
            messageTemplates.key,
            messageTemplates.channel,
            messageTemplates.language,
          ],
          set: {
            body: body.body,
            providerTemplateName: body.providerTemplateName,
            isActive: true,
            updatedByMemberId: auth.memberId,
            updatedAt: new Date(),
          },
        }),
    );
    return this.templates(auth);
  }

  /** Goes back to the product's wording for one template. */
  async resetTemplate(auth: AuthContext, key: TemplateKeyInput): Promise<TemplateView[]> {
    await withTenant(this.connection.db, auth.organization.id, (tx) =>
      tx
        .delete(messageTemplates)
        .where(
          and(
            eq(messageTemplates.key, key.key),
            eq(messageTemplates.channel, key.channel),
            eq(messageTemplates.language, key.language),
          ),
        ),
    );
    return this.templates(auth);
  }
}
