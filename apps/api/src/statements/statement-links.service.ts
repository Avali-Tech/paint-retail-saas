import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import {
  PAYMENT_LINK_MANAGE_PERMISSION,
  STATEMENT_LINK_DAYS,
  can,
  STATEMENT_TOKEN_PATTERN,
  formatINR,
  formatPrintDate,
  statementShareText,
  type MemberAccess,
  type MessageLanguage,
  type QueueResult,
  type StatementData,
  type StatementLinkView,
  type StatementShareResult,
} from '@paint/shared';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import {
  MESSAGING_SETTINGS,
  visibleParty,
  type MessagingSettings,
} from '../messaging/messaging.service.js';
import { queueMessage } from '../messaging/outbox.js';
import { createLink, planLink, reusableLink } from '../payment-links/links.js';
import {
  PAYMENT_LINK_GATEWAYS,
  type PaymentLinkGateways,
} from '../payment-links/payment-link-gateways.js';
import type { ShareStatementInput } from './statements.schemas.js';
import { statementData } from './statements.service.js';

const { organizationMembers, organizations, paymentLinks, statementLinks, users } = schema;

export const STATEMENT_LINK_SETTINGS = Symbol('STATEMENT_LINK_SETTINGS');
export interface StatementLinkSettings {
  /** The API's public address, e.g. https://app.example.in/api. */
  readonly publicApiUrl: string;
}

/** A stored link sees the party whatever its store: the business shared it. */
const LINK_ACCESS: MemberAccess = { permissions: new Set(), allStores: true, storeIds: new Set() };

/** Hex SHA-256 of a link token; only this is stored. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** wa.me with a message, to a mobile in E.164. */
export function whatsappLink(phone: string, text: string): string {
  return `https://wa.me/${phone.replace(/^\+/, '')}?text=${encodeURIComponent(text)}`;
}

const linkColumns = {
  id: statementLinks.id,
  from: statementLinks.fromOn,
  to: statementLinks.toOn,
  language: statementLinks.language,
  status: sql<StatementLinkView['status']>`case
    when ${statementLinks.revokedAt} is not null then 'revoked'
    when ${statementLinks.expiresAt} <= now() then 'expired'
    else 'active' end`,
  expiresAt: statementLinks.expiresAt,
  revokedAt: statementLinks.revokedAt,
  openedCount: statementLinks.openedCount,
  lastOpenedAt: statementLinks.lastOpenedAt,
  createdBy: users.fullName,
  createdAt: statementLinks.createdAt,
};

async function linkViews(
  tx: Transaction,
  where: ReturnType<typeof eq>,
): Promise<StatementLinkView[]> {
  const rows = await tx
    .select(linkColumns)
    .from(statementLinks)
    .innerJoin(organizationMembers, eq(organizationMembers.id, statementLinks.createdByMemberId))
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(where)
    .orderBy(desc(statementLinks.createdAt), desc(statementLinks.id));
  return rows.map((row) => ({
    ...row,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastOpenedAt: row.lastOpenedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Stored statement links (P2-M12, spec §6.4): a member shares a statement as a
 * link that works without signing in until it expires or is revoked; with a
 * WhatsApp provider the `statement_ready` message carries it (P2-M32).
 */
@Injectable()
export class StatementLinksService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(MESSAGING_SETTINGS) private readonly messaging: MessagingSettings,
    @Inject(STATEMENT_LINK_SETTINGS) private readonly settings: StatementLinkSettings,
    @Inject(PAYMENT_LINK_GATEWAYS) private readonly gateways: PaymentLinkGateways,
  ) {}

  share(
    auth: AuthContext,
    partyId: string,
    body: ShareStatementInput,
  ): Promise<StatementShareResult> {
    if (body.send === 'whatsapp' && this.messaging.whatsapp === null) {
      throw new ConflictException({
        statusCode: 409,
        code: 'whatsapp_off',
        message: 'WhatsApp messages are not set up: share the link instead',
      });
    }
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const data = await statementData(tx, auth, auth.organization.id, partyId, body);
      const token = randomBytes(32).toString('base64url');
      const [created] = (await tx
        .insert(statementLinks)
        .values({
          organizationId: auth.organization.id,
          partyId,
          fromOn: body.from,
          toOn: body.to,
          language: body.lang,
          tokenHash: tokenHash(token),
          expiresAt: sql`now() + make_interval(days => ${STATEMENT_LINK_DAYS})`,
          createdByMemberId: auth.memberId,
        })
        .returning({ id: statementLinks.id })) as [{ id: string }];
      const url = `${this.settings.publicApiUrl}/public/statements/${token}`;
      const paymentLink = await this.payLink(tx, auth, data);
      const message =
        body.send === 'whatsapp'
          ? await this.queueStatement(tx, auth, data, created.id, url, body, paymentLink)
          : null;
      const [link] = (await linkViews(tx, eq(statementLinks.id, created.id))) as [
        StatementLinkView,
      ];
      return {
        link,
        url,
        waMeUrl:
          data.party.phone === null
            ? null
            : whatsappLink(
                data.party.phone,
                statementShareText(
                  data,
                  body.lang,
                  url,
                  paymentLink?.url ?? null,
                  paymentLink?.amountPaise ?? null,
                ),
              ),
        message,
        paymentLink,
      };
    });
  }

  /**
   * A UPI link for what the party owes now (rule PL-12), when payment links are set up,
   * the party owes something and the member may take payments where it is recorded (the
   * party's home store, else its oldest open bill's store): an open one already made for
   * the same amount and bills, or a new one. Null otherwise; the share goes without.
   */
  private async payLink(
    tx: Transaction,
    auth: AuthContext,
    data: StatementData,
  ): Promise<{ number: string; url: string; amountPaise: number } | null> {
    const provider = await this.gateways.forBusiness(tx, auth.organization.id);
    if (provider === null) return null;
    const plan = await planLink(tx, { partyId: data.party.id, purpose: 'outstanding' });
    if (!plan.ok) return null;
    const [where] = (
      await tx.execute<{ store_id: string | null }>(sql`
      select coalesce(p.home_store_id, (
        select d.store_id from tax_documents d
        where d.party_id = p.id and d.status = 'issued'
          and d.kind in ('invoice', 'bill_of_supply', 'debit_note')
          and d.total_paise > coalesce((select sum(a.amount_paise) from allocations a where a.document_id = d.id), 0)
        order by d.issued_on, d.issued_at, d.id
        limit 1
      )) as store_id
      from parties p where p.id = ${data.party.id}`)
    ).rows as [{ store_id: string | null }];
    const storeId = where.store_id;
    if (storeId === null || !can(auth, PAYMENT_LINK_MANAGE_PERMISSION, storeId)) return null;
    const link = {
      organizationId: auth.organization.id,
      partyId: data.party.id,
      storeId,
      purpose: 'outstanding' as const,
      origin: 'statement' as const,
      targets: plan.targets,
      amountPaise: plan.amountPaise,
      memberId: auth.memberId,
    };
    const id = (await reusableLink(tx, link)) ?? (await createLink(tx, provider, link));
    const [row] = (await tx
      .select({
        number: paymentLinks.number,
        url: paymentLinks.url,
        amountPaise: paymentLinks.amountPaise,
      })
      .from(paymentLinks)
      .where(eq(paymentLinks.id, id))) as [{ number: string; url: string; amountPaise: number }];
    return row;
  }

  private queueStatement(
    tx: Transaction,
    auth: AuthContext,
    data: StatementData,
    linkId: string,
    url: string,
    body: ShareStatementInput,
    paymentLink: { url: string; amountPaise: number } | null,
  ): Promise<QueueResult> {
    return queueMessage(tx, {
      organizationId: auth.organization.id,
      partyId: data.party.id,
      channel: 'whatsapp',
      templateKey: 'statement_ready',
      variables: {
        from: formatPrintDate(body.from),
        to: formatPrintDate(body.to),
        amount: formatINR(data.closingPaise),
        link: url,
      },
      reference: { type: 'statement_link', id: linkId },
      memberId: auth.memberId,
      payLinkUrl: paymentLink?.url ?? null,
      // The statement names its balance; a link asking for another amount says so ([PO-43]).
      payLinkAmount:
        paymentLink === null || paymentLink.amountPaise === data.closingPaise
          ? null
          : formatINR(paymentLink.amountPaise),
    });
  }

  /** A party's shared links, newest first (never the token: it is not stored). */
  links(auth: AuthContext, partyId: string): Promise<StatementLinkView[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await visibleParty(tx, auth, partyId);
      return linkViews(tx, eq(statementLinks.partyId, partyId));
    });
  }

  /** Stops a link working at once. */
  revoke(auth: AuthContext, linkId: string): Promise<StatementLinkView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [link] = await tx
        .select({ partyId: statementLinks.partyId, revokedAt: statementLinks.revokedAt })
        .from(statementLinks)
        .where(eq(statementLinks.id, linkId));
      if (!link) throw new NotFoundException('Link not found');
      await visibleParty(tx, auth, link.partyId).catch(() => {
        throw new NotFoundException('Link not found');
      });
      if (link.revokedAt !== null) throw new ConflictException('This link is already revoked');
      await tx
        .update(statementLinks)
        .set({ revokedAt: sql`now()`, revokedByMemberId: auth.memberId })
        .where(eq(statementLinks.id, linkId));
      const [view] = (await linkViews(tx, eq(statementLinks.id, linkId))) as [StatementLinkView];
      return view;
    });
  }

  /**
   * The statement a public link points to, for GET /public/statements/:token. The
   * token is looked up outside tenant scope (as public branding is, by its hash
   * only), then the statement is built inside the business's tenant transaction.
   * Unknown, expired, revoked and suspended-business links all answer the same 404.
   */
  async publicStatement(token: string): Promise<StatementData & { language: MessageLanguage }> {
    if (!STATEMENT_TOKEN_PATTERN.test(token)) throw new NotFoundException('Not found');
    const [link] = await this.connection.db
      .select({
        id: statementLinks.id,
        organizationId: statementLinks.organizationId,
        partyId: statementLinks.partyId,
        from: statementLinks.fromOn,
        to: statementLinks.toOn,
        language: statementLinks.language,
      })
      .from(statementLinks)
      .innerJoin(organizations, eq(organizations.id, statementLinks.organizationId))
      .where(
        and(
          eq(statementLinks.tokenHash, tokenHash(token)),
          isNull(statementLinks.revokedAt),
          gt(statementLinks.expiresAt, sql`now()`),
          isNull(organizations.suspendedAt),
        ),
      );
    if (!link) throw new NotFoundException('Not found');
    return withTenant(this.connection.db, link.organizationId, async (tx) => {
      await tx
        .update(statementLinks)
        .set({
          openedCount: sql`${statementLinks.openedCount} + 1`,
          lastOpenedAt: sql`now()`,
        })
        .where(eq(statementLinks.id, link.id));
      const data = await statementData(tx, LINK_ACCESS, link.organizationId, link.partyId, link);
      return { ...data, language: link.language };
    });
  }
}
