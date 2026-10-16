import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import { pointLots } from '@paint/shared';
import { and, eq, inArray, sql, type AnyColumn } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { todayInIndia } from '../contracts/contract-dates.js';
import { DATABASE } from '../database/database.module.js';
import { entriesOf, expireAccount } from '../loyalty/loyalty-lookups.js';
import { PartiesService, type PartyView } from './parties.service.js';

const {
  activities,
  brandStatementTemplates,
  creditApprovals,
  creditProfiles,
  creditRequests,
  customerProfiles,
  documents,
  estimates,
  goLiveOpenings,
  loyaltyAccounts,
  loyaltyLedger,
  messageOutbox,
  messagingConsents,
  paymentLinks,
  promisesToPay,
  statementLinks,
  parties,
  partyLedger,
  salesSettings,
  supplierProfiles,
  quotations,
  salesOrders,
  taxDocuments,
  siteCreditAccounts,
} = schema;

/** Records that simply move to the surviving party: table and column. */
const MOVED: readonly (readonly [string, string])[] = [
  ['leads', 'party_id'],
  ['leads', 'referred_by_party_id'],
  ['opportunities', 'party_id'],
  ['projects', 'customer_party_id'],
  ['contracts', 'party_id'],
  ['purchase_orders', 'supplier_party_id'],
  ['goods_receipts', 'supplier_party_id'],
  ['credit_requests', 'party_id'],
  ['ledger_mappings', 'party_id'],
];

/**
 * Every column that references a party, and how a merge handles it. A guard
 * test fails when a table references parties without being listed here.
 */
export const MERGE_HANDLED: readonly string[] = [
  ...MOVED.map(([table, column]) => `${table}.${column}`),
  // The survivor keeps its roles and gains the duplicate's.
  'party_roles.party_id',
  // One per party: the survivor's is kept; the duplicate's moves only if the survivor has none.
  'customer_profiles.party_id',
  'supplier_profiles.party_id',
  // Moved unless the survivor already has the same row.
  'supplier_products.supplier_party_id',
  'project_parties.party_id',
  // See creditProfile() and loyalty() below. Site accounts go with the credit profile;
  // credit approvals are decisions about the party they name, so creditProfile() refuses them.
  'credit_profiles.party_id',
  'site_credit_accounts.party_id',
  'credit_approvals.party_id',
  'loyalty_accounts.party_id',
  // Billing history is permanent: see billing() below. Drafts move.
  'tax_documents.party_id',
  'tax_documents.influencer_party_id',
  // Sent quotations and confirmed orders are records too; drafts move.
  'quotations.bill_to_party_id',
  'quotations.influencer_party_id',
  'sales_orders.bill_to_party_id',
  'sales_orders.influencer_party_id',
  'party_ledger.party_id',
  'party_balances.party_id',
  'sales_settings.walk_in_party_id',
  // Every payment has a party ledger entry, so billing() refuses these too.
  'payments.party_id',
  'allocations.party_id',
  // Draft estimates move; a converted one is final (its quotation is the record).
  'estimates.party_id',
  // Shade history is never rewritten: the search by party follows merges instead.
  'tint_records.party_id',
  // An imported opening balance belongs to the party it was imported for: billing() refuses.
  'go_live_openings.party_id',
  // What a reconciliation found is a record of that day, never rewritten.
  'reconciliation_findings.party_id',
  // Collections and messages (MVP 3 round 2a): see collections() below. Promises (and
  // the escalations of broken ones) are records of what that party said: refused.
  'promises_to_pay.party_id',
  'collection_escalations.party_id',
  // Messages stay as sent; queued ones are not sent. Consent is never carried over,
  // but a withdrawal is (the stricter choice wins). Shared statement links are revoked.
  'message_outbox.party_id',
  'messaging_consents.party_id',
  'statement_links.party_id',
  // A payment link asked that party for money, and the gateway may still pay it (round
  // 4a): see collections() below, which refuses a duplicate with any.
  'payment_links.party_id',
  // Brand statements (round 6a) are the supplier's records, reconciled with its GRNs: a
  // supplier with a statement template (every statement has one) is never merged away.
  'brand_statement_templates.supplier_party_id',
  'brand_statements.supplier_party_id',
];

export interface MergeResult {
  readonly party: PartyView;
  /** Rows moved to the surviving party, by table and column. */
  readonly moved: Record<string, number>;
}

/**
 * Merges a duplicate party into a survivor (one transaction): every record
 * that pointed at the duplicate points at the survivor, and the duplicate is
 * deactivated with a marker to the survivor so old links still lead somewhere.
 */
@Injectable()
export class PartyMergeService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(PartiesService) private readonly parties: PartiesService,
  ) {}

  async merge(auth: AuthContext, duplicateId: string, survivorId: string): Promise<MergeResult> {
    // A party's records can be at any store, so only members who see every store merge.
    if (!auth.allStores) {
      throw new ForbiddenException('Only members who work at every store can merge parties');
    }
    if (duplicateId === survivorId) {
      throw new BadRequestException('Choose another party to merge into');
    }
    const moved = await withTenant(this.connection.db, auth.organization.id, async (tx) => {
      // Locked in id order, so two merges of the same pair cannot deadlock.
      const locked = await tx
        .select()
        .from(parties)
        .where(inArray(parties.id, [duplicateId, survivorId]))
        .orderBy(parties.id)
        .for('update');
      const duplicate = locked.find((row) => row.id === duplicateId);
      const survivor = locked.find((row) => row.id === survivorId);
      if (!duplicate) throw new NotFoundException('Party not found');
      if (!survivor) throw new BadRequestException('Unknown party to merge into');
      if (duplicate.mergedIntoId) {
        throw new ConflictException('This party was already merged into another');
      }
      if (!survivor.isActive) throw new BadRequestException('Merge into an active party');

      const counts: Record<string, number> = {};
      await this.billing(tx, duplicateId, survivorId, counts);
      await this.creditProfile(tx, duplicateId, survivorId, counts);
      await this.collections(tx, auth, duplicateId, survivorId, counts);
      for (const [table, column] of MOVED) {
        const moved = await tx.execute(
          sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${survivorId} where ${sql.identifier(column)} = ${duplicateId}`,
        );
        counts[`${table}.${column}`] = Number(moved.rowCount);
      }
      counts['party_roles.party_id'] = await this.roles(tx, auth, duplicateId, survivorId);
      counts['customer_profiles.party_id'] = await this.onePerParty(
        tx,
        customerProfiles,
        customerProfiles.partyId,
        duplicateId,
        survivorId,
      );
      counts['supplier_profiles.party_id'] = await this.onePerParty(
        tx,
        supplierProfiles,
        supplierProfiles.partyId,
        duplicateId,
        survivorId,
      );
      counts['supplier_products.supplier_party_id'] = await this.unlessDuplicate(
        tx,
        duplicateId,
        survivorId,
        'supplier_products',
        'supplier_party_id',
        'variant_id',
      );
      counts['project_parties.party_id'] = await this.unlessDuplicate(
        tx,
        duplicateId,
        survivorId,
        'project_parties',
        'party_id',
        'project_id, role',
      );
      counts['loyalty_accounts.party_id'] = await this.loyalty(tx, auth, duplicateId, survivorId);
      counts['estimates.party_id'] = (
        await tx
          .update(estimates)
          .set({ partyId: survivorId, updatedAt: sql`now()` })
          .where(and(eq(estimates.partyId, duplicateId), eq(estimates.status, 'draft')))
          .returning({ id: estimates.id })
      ).length;
      // Activities and documents about the party itself.
      counts.activities = (
        await tx
          .update(activities)
          .set({ recordId: survivorId })
          .where(and(eq(activities.recordType, 'party'), eq(activities.recordId, duplicateId)))
          .returning({ id: activities.id })
      ).length;
      counts.documents = (
        await tx
          .update(documents)
          .set({ recordId: survivorId })
          .where(and(eq(documents.recordType, 'party'), eq(documents.recordId, duplicateId)))
          .returning({ id: documents.id })
      ).length;

      await tx
        .update(parties)
        .set({
          isActive: false,
          mergedIntoId: survivorId,
          mergedAt: sql`now()`,
          mergedByMemberId: auth.memberId,
          updatedAt: sql`now()`,
        })
        .where(eq(parties.id, duplicateId));
      return counts;
    });
    return { party: await this.parties.get(auth, survivorId), moved };
  }

  // Helpers -----------------------------------------------------------------

  /**
   * Billing: issued invoices and the party ledger are permanent records of the
   * party they name, so a duplicate with any (or the walk-in party) is refused;
   * merge the other way. Draft bills move to the survivor.
   */
  private async billing(
    tx: Transaction,
    duplicateId: string,
    survivorId: string,
    counts: Record<string, number>,
  ): Promise<void> {
    const history = await tx.execute(sql`
      select 1 from ${partyLedger} where ${partyLedger.partyId} = ${duplicateId}
      union all
      select 1 from ${taxDocuments} where ${taxDocuments.status} <> 'draft'
        and ${duplicateId} in (${taxDocuments.partyId}, ${taxDocuments.influencerPartyId})
      union all
      select 1 from ${quotations} where ${quotations.status} <> 'draft'
        and ${duplicateId} in (${quotations.billToPartyId}, ${quotations.influencerPartyId})
      union all
      select 1 from ${salesOrders} where ${salesOrders.status} <> 'draft'
        and ${duplicateId} in (${salesOrders.billToPartyId}, ${salesOrders.influencerPartyId})
      union all
      select 1 from ${salesSettings} where ${salesSettings.walkInPartyId} = ${duplicateId}
      limit 1`);
    if (history.rows.length > 0) {
      throw new ConflictException(
        'This party has invoices, sent quotations or orders, or is the walk-in customer; merge the other way',
      );
    }
    const [imported] = await tx
      .select({ id: goLiveOpenings.id })
      .from(goLiveOpenings)
      .where(eq(goLiveOpenings.partyId, duplicateId));
    if (imported) {
      throw new ConflictException(
        'This party has an imported opening balance; merge the other way, or import it for the other party',
      );
    }
    for (const [name, table] of [
      ['quotations', quotations],
      ['sales_orders', salesOrders],
    ] as const) {
      for (const field of ['billToPartyId', 'influencerPartyId'] as const) {
        counts[`${name}.${table[field].name}`] = (
          await tx
            .update(table)
            .set({ [field]: survivorId })
            .where(eq(table[field], duplicateId))
            .returning({ id: table.id })
        ).length;
      }
    }
    for (const column of [taxDocuments.partyId, taxDocuments.influencerPartyId]) {
      counts[`tax_documents.${column.name}`] = (
        await tx
          .update(taxDocuments)
          .set({ [column.name === 'party_id' ? 'partyId' : 'influencerPartyId']: survivorId })
          .where(eq(column, duplicateId))
          .returning({ id: taxDocuments.id })
      ).length;
    }
  }

  /**
   * Credit: refused when both parties have a request waiting, or both have a
   * profile and the duplicate's gives credit (merge the other way, or end one's
   * credit first), or the duplicate has credit approvals (a decision about the
   * party it names). The duplicate's profile, and its site accounts, move when
   * the survivor has none; a duplicate profile without credit stays with the
   * duplicate, and then it may have no site accounts.
   */
  private async creditProfile(
    tx: Transaction,
    duplicateId: string,
    survivorId: string,
    counts: Record<string, number>,
  ): Promise<void> {
    const pending = await tx
      .select({ partyId: creditRequests.partyId })
      .from(creditRequests)
      .where(
        and(
          inArray(creditRequests.partyId, [duplicateId, survivorId]),
          eq(creditRequests.status, 'pending'),
        ),
      );
    if (pending.length === 2) {
      throw new ConflictException('Both parties have a credit request waiting; decide one first');
    }
    const profiles = await tx
      .select({ partyId: creditProfiles.partyId, status: creditProfiles.status })
      .from(creditProfiles)
      .where(inArray(creditProfiles.partyId, [duplicateId, survivorId]));
    const duplicate = profiles.find((row) => row.partyId === duplicateId);
    const survivor = profiles.find((row) => row.partyId === survivorId);
    if (duplicate && survivor && duplicate.status !== 'none') {
      throw new ConflictException(
        'Both parties have a credit profile; merge the other way or end one’s credit first',
      );
    }
    const [approval] = await tx
      .select({ id: creditApprovals.id })
      .from(creditApprovals)
      .where(eq(creditApprovals.partyId, duplicateId))
      .limit(1);
    if (approval) {
      throw new ConflictException('This party has credit approvals; merge the other way');
    }
    const moves = duplicate !== undefined && survivor === undefined;
    const [site] = await tx
      .select({ id: siteCreditAccounts.id })
      .from(siteCreditAccounts)
      .where(eq(siteCreditAccounts.partyId, duplicateId))
      .limit(1);
    if (site && !moves) {
      throw new ConflictException('This party has site accounts; merge the other way');
    }
    counts['credit_profiles.party_id'] = moves
      ? (
          await tx
            .update(creditProfiles)
            .set({ partyId: survivorId, updatedAt: sql`now()` })
            .where(eq(creditProfiles.partyId, duplicateId))
            .returning({ id: creditProfiles.id })
        ).length
      : 0;
    counts['site_credit_accounts.party_id'] = (
      await tx
        .update(siteCreditAccounts)
        .set({ partyId: survivorId, updatedAt: sql`now()` })
        .where(eq(siteCreditAccounts.partyId, duplicateId))
        .returning({ id: siteCreditAccounts.id })
    ).length;
  }

  /**
   * Collections and messages (MVP 3 round 2a). A promise to pay (and its escalation)
   * is what that party said and never changes, so a duplicate with any is refused:
   * merge the other way. The duplicate's messages stay its own record; those still
   * queued are not sent. Consent to messages is the person's choice at an address, so
   * a grant is never carried over (the survivor is asked again), but a withdrawal is,
   * when the survivor's own consent on that channel is still a grant. The duplicate's
   * shared statement links stop working.
   */
  private async collections(
    tx: Transaction,
    auth: AuthContext,
    duplicateId: string,
    survivorId: string,
    counts: Record<string, number>,
  ): Promise<void> {
    const [promise] = await tx
      .select({ id: promisesToPay.id })
      .from(promisesToPay)
      .where(eq(promisesToPay.partyId, duplicateId))
      .limit(1);
    if (promise) {
      throw new ConflictException('This party has promises to pay; merge the other way');
    }
    const [link] = await tx
      .select({ id: paymentLinks.id })
      .from(paymentLinks)
      .where(eq(paymentLinks.partyId, duplicateId))
      .limit(1);
    if (link) {
      throw new ConflictException('This party has payment links; merge the other way');
    }
    const [template] = await tx
      .select({ id: brandStatementTemplates.id })
      .from(brandStatementTemplates)
      .where(eq(brandStatementTemplates.supplierPartyId, duplicateId))
      .limit(1);
    if (template) {
      throw new ConflictException('This supplier has brand statements; merge the other way');
    }
    counts['message_outbox.party_id'] = (
      await tx
        .update(messageOutbox)
        .set({ status: 'skipped', skipReason: 'party_merged' })
        .where(and(eq(messageOutbox.partyId, duplicateId), eq(messageOutbox.status, 'queued')))
        .returning({ id: messageOutbox.id })
    ).length;
    const latest = await tx.execute<{
      party_id: string;
      channel: 'whatsapp' | 'sms' | 'email';
      address: string;
      state: 'granted' | 'withdrawn';
      method: 'counter_with_notice' | 'signed_form' | 'web_form' | 'whatsapp_reply';
      notice_version: string;
      language: 'en' | 'hi' | 'te';
    }>(sql`
      select distinct on (party_id, channel) party_id, channel, address, state, method,
        notice_version, language
      from messaging_consents
      where party_id in (${duplicateId}, ${survivorId})
      order by party_id, channel, recorded_at desc`);
    const withdrawals = latest.rows.filter(
      (row) =>
        row.party_id === duplicateId &&
        row.state === 'withdrawn' &&
        latest.rows.some(
          (other) =>
            other.party_id === survivorId &&
            other.channel === row.channel &&
            other.state === 'granted',
        ),
    );
    for (const withdrawal of withdrawals) {
      const granted = latest.rows.find(
        (row) => row.party_id === survivorId && row.channel === withdrawal.channel,
      ) as { address: string };
      await tx.insert(messagingConsents).values({
        organizationId: auth.organization.id,
        partyId: survivorId,
        channel: withdrawal.channel,
        address: granted.address,
        state: 'withdrawn',
        method: withdrawal.method,
        noticeVersion: withdrawal.notice_version,
        language: withdrawal.language,
        recordedByMemberId: auth.memberId,
      });
    }
    counts['messaging_consents.party_id'] = withdrawals.length;
    counts['statement_links.party_id'] = (
      await tx
        .update(statementLinks)
        .set({ revokedAt: sql`now()`, revokedByMemberId: auth.memberId })
        .where(
          and(eq(statementLinks.partyId, duplicateId), sql`${statementLinks.revokedAt} is null`),
        )
        .returning({ id: statementLinks.id })
    ).length;
  }

  /** The survivor gains the duplicate's roles; the duplicate keeps them for its history. */
  private async roles(
    tx: Transaction,
    auth: AuthContext,
    duplicateId: string,
    survivorId: string,
  ): Promise<number> {
    const added = await tx.execute(sql`
      insert into party_roles (organization_id, party_id, role)
      select ${auth.organization.id}, ${survivorId}, r.role from party_roles r where r.party_id = ${duplicateId}
      on conflict do nothing`);
    return Number(added.rowCount);
  }

  /** Moves the duplicate's one-per-party row when the survivor has none. */
  private async onePerParty(
    tx: Transaction,
    table: typeof customerProfiles | typeof supplierProfiles,
    column: AnyColumn,
    duplicateId: string,
    survivorId: string,
  ): Promise<number> {
    const [survivorRow] = await tx
      .select({ one: sql`1` })
      .from(table)
      .where(eq(column, survivorId));
    if (survivorRow) return 0;
    return (
      await tx
        .update(table)
        .set({ partyId: survivorId })
        .where(eq(column, duplicateId))
        .returning({ one: sql`1` })
    ).length;
  }

  /** Moves the duplicate's rows unless the survivor already has the same one (same `match`). */
  private async unlessDuplicate(
    tx: Transaction,
    duplicateId: string,
    survivorId: string,
    table: 'supplier_products' | 'project_parties',
    column: string,
    match: string,
  ): Promise<number> {
    // Names come only from the constants above; the ids are parameters.
    const same = sql.raw(
      match
        .split(', ')
        .map((key) => `s.${key} = d.${key}`)
        .join(' and '),
    );
    const name = sql.identifier(table);
    const party = sql.identifier(column);
    const result = await tx.execute(sql`
      update ${name} d set ${party} = ${survivorId}
      where d.${party} = ${duplicateId}
        and not exists (select 1 from ${name} s where s.${party} = ${survivorId} and ${same})`);
    return Number(result.rowCount);
  }

  /**
   * Loyalty: the duplicate's account moves when the survivor has none.
   * Otherwise its unused points move as adjustments (the ledger is append-only),
   * each lot keeping its expiry date, and the duplicate's account is closed.
   */
  private async loyalty(
    tx: Transaction,
    auth: AuthContext,
    duplicateId: string,
    survivorId: string,
  ): Promise<number> {
    const accounts = await tx
      .select({ id: loyaltyAccounts.id, partyId: loyaltyAccounts.partyId })
      .from(loyaltyAccounts)
      .where(inArray(loyaltyAccounts.partyId, [duplicateId, survivorId]))
      .for('update');
    const duplicate = accounts.find((row) => row.partyId === duplicateId);
    const survivor = accounts.find((row) => row.partyId === survivorId);
    if (!duplicate) return 0;
    if (!survivor) {
      await tx
        .update(loyaltyAccounts)
        .set({ partyId: survivorId, updatedAt: sql`now()` })
        .where(eq(loyaltyAccounts.id, duplicate.id));
      return 1;
    }
    const organizationId = auth.organization.id;
    const today = todayInIndia();
    await expireAccount(tx, organizationId, duplicate.id, today);
    const { unused } = pointLots(await entriesOf(tx, organizationId, duplicate.id), today);
    const total = unused.reduce((sum, lot) => sum + lot.points, 0);
    if (total > 0) {
      const note = 'Moved when duplicate parties were merged';
      await tx.insert(loyaltyLedger).values([
        {
          organizationId,
          accountId: duplicate.id,
          kind: 'adjust',
          points: -total,
          note,
          createdByMemberId: auth.memberId,
        },
        ...unused.map((lot) => ({
          organizationId,
          accountId: survivor.id,
          kind: 'adjust' as const,
          points: lot.points,
          expiresOn: lot.expiresOn,
          note,
          createdByMemberId: auth.memberId,
        })),
      ]);
    }
    await tx
      .update(loyaltyAccounts)
      .set({ status: 'closed', updatedAt: sql`now()` })
      .where(eq(loyaltyAccounts.id, duplicate.id));
    return 0;
  }
}
