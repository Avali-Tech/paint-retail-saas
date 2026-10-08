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
import { pointsForPurchase, tierFor } from '@paint/shared';
import { and, count, desc, eq, ilike, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { addDays, todayInIndia } from '../contracts/contract-dates.js';
import { billingLiveOn, visibleParties } from '../credit/credit-lookups.js';
import { DATABASE } from '../database/database.module.js';
import { requireSalesperson } from '../leads/crm-lookups.js';
import { Notifier } from '../notifications/notifier.js';
import { canSeeParty, containsPattern } from '../parties/party-access.js';
import {
  entriesOf,
  expireAccount,
  loyaltySettingsOf,
  loyaltySummaryOf,
  type LoyaltySettings,
  type LoyaltySummary,
} from './loyalty-lookups.js';
import type {
  AdjustInput,
  AwardInput,
  ListAccountsQuery,
  PurchaseInput,
  RedeemInput,
  UpdateAccountInput,
} from './loyalty.schemas.js';

const { loyaltyAccounts, loyaltyLedger, loyaltySettings, organizationMembers, parties, users } =
  schema;

type AccountRow = typeof loyaltyAccounts.$inferSelect;
type NewEntry = Omit<
  typeof loyaltyLedger.$inferInsert,
  'organizationId' | 'accountId' | 'createdByMemberId' | 'expiresOn'
>;

export interface LedgerEntryView {
  readonly id: string;
  readonly kind: (typeof schema.loyaltyEntryKind.enumValues)[number];
  readonly points: number;
  readonly manualPurchasePaise: number | null;
  readonly reference: string | null;
  readonly note: string | null;
  readonly expiresOn: string | null;
  /** Null for points the system expired. */
  readonly createdBy: { readonly memberId: string; readonly name: string } | null;
  readonly createdAt: string;
}

export interface LoyaltyView extends LoyaltySummary {
  readonly party: { readonly id: string; readonly name: string };
  /** Newest first. */
  readonly ledger: { readonly items: LedgerEntryView[]; readonly total: number };
}

interface PartyRow {
  id: string;
  name: string;
  homeStoreId: string | null;
}

/** Loyalty accounts and the points ledger (roadmap P1-M26). */
@Injectable()
export class LoyaltyService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(Notifier) private readonly notifier: Notifier,
  ) {}

  get(
    auth: AuthContext,
    partyId: string,
    page: { limit: number; offset: number },
  ): Promise<LoyaltyView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const party = await this.party(tx, auth, partyId);
      return this.view(tx, auth, party, page);
    });
  }

  /** Opens a loyalty account for the party. */
  enrol(auth: AuthContext, partyId: string, assignedMemberId?: string): Promise<LoyaltyView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const party = await this.party(tx, auth, partyId, true);
      const [existing] = await tx
        .select({ id: loyaltyAccounts.id })
        .from(loyaltyAccounts)
        .where(eq(loyaltyAccounts.partyId, partyId));
      if (existing) throw new ConflictException('This party already has a loyalty account');
      if (assignedMemberId) {
        await requireSalesperson(tx, assignedMemberId, party.homeStoreId, 'loyalty:manage');
      }
      await tx.insert(loyaltyAccounts).values({
        organizationId: auth.organization.id,
        partyId,
        assignedMemberId,
        createdByMemberId: auth.memberId,
      });
      return this.view(tx, auth, party);
    });
  }

  /** Closes or reopens the account, or changes who looks after it. */
  update(auth: AuthContext, partyId: string, input: UpdateAccountInput): Promise<LoyaltyView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const party = await this.party(tx, auth, partyId, true);
      const account = await this.account(tx, partyId);
      if (input.assignedMemberId) {
        await requireSalesperson(tx, input.assignedMemberId, party.homeStoreId, 'loyalty:manage');
      }
      await tx
        .update(loyaltyAccounts)
        .set({ ...input, updatedAt: sql`now()` })
        .where(eq(loyaltyAccounts.id, account.id));
      return this.view(tx, auth, party);
    });
  }

  /** Points for a purchase entered by hand, at the programme's earn rate. */
  recordPurchase(auth: AuthContext, partyId: string, input: PurchaseInput): Promise<LoyaltyView> {
    return this.post(auth, partyId, async (_account, settings, tx) => {
      if ((await billingLiveOn(tx)) !== null) {
        throw new ConflictException('Billing is live: invoices earn points now (spec §4.7)');
      }
      const points = pointsForPurchase(input.manualPurchasePaise, settings);
      if (points === 0) throw new BadRequestException('This purchase is too small to earn points');
      return { kind: 'purchase', points, ...input };
    });
  }

  /** A manual award, or a campaign award when a campaign is named. */
  award(auth: AuthContext, partyId: string, input: AwardInput): Promise<LoyaltyView> {
    return this.post(auth, partyId, () =>
      Promise.resolve({
        kind: input.campaign ? 'campaign' : 'award',
        points: input.points,
        reference: input.campaign,
        note: input.note,
      }),
    );
  }

  /** Spends points; never more than the balance, never less than the minimum. */
  redeem(auth: AuthContext, partyId: string, input: RedeemInput): Promise<LoyaltyView> {
    return this.post(auth, partyId, async (account, settings, tx) => {
      if (input.points < settings.minRedemptionPoints) {
        throw new BadRequestException(
          `Redeem at least ${String(settings.minRedemptionPoints)} points`,
        );
      }
      await this.requireBalance(tx, auth, account, input.points);
      return { kind: 'redeem', points: -input.points, note: input.note };
    });
  }

  /** Corrects the balance, with a reason; it cannot go below zero. */
  adjust(auth: AuthContext, partyId: string, input: AdjustInput): Promise<LoyaltyView> {
    return this.post(auth, partyId, async (account, _settings, tx) => {
      if (input.points < 0) await this.requireBalance(tx, auth, account, -input.points);
      return { kind: 'adjust', points: input.points, note: input.reason };
    });
  }

  /** Enrolled parties, most points first. */
  list(auth: AuthContext, query: ListAccountsQuery) {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        visibleParties(auth),
        query.status ? eq(loyaltyAccounts.status, query.status) : undefined,
        query.q ? ilike(parties.displayName, containsPattern(query.q)) : undefined,
      );
      // Explicit table names: the subqueries must not pick up the ledger's own columns.
      const balance = sql<number>`(select coalesce(sum(l.points), 0)::int from loyalty_ledger l where l.account_id = "loyalty_accounts"."id")`;
      const earned = sql<number>`(select coalesce(sum(l.points), 0)::int from loyalty_ledger l where l.account_id = "loyalty_accounts"."id" and l.points > 0)`;
      const rows = await tx
        .select({
          party: { id: parties.id, name: parties.displayName },
          status: loyaltyAccounts.status,
          balance,
          earned,
        })
        .from(loyaltyAccounts)
        .innerJoin(parties, eq(parties.id, loyaltyAccounts.partyId))
        .where(where)
        .orderBy(desc(balance), parties.displayName)
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx
        .select({ total: count() })
        .from(loyaltyAccounts)
        .innerJoin(parties, eq(parties.id, loyaltyAccounts.partyId))
        .where(where);
      const { tiers } = await loyaltySettingsOf(tx, auth.organization.id);
      return {
        items: rows.map((row) => ({
          party: row.party,
          status: row.status,
          balance: row.balance,
          totalEarned: row.earned,
          tier: tierFor(row.earned, tiers).current,
        })),
        total: Number(totals?.total),
      };
    });
  }

  settings(auth: AuthContext): Promise<LoyaltySettings> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      loyaltySettingsOf(tx, auth.organization.id),
    );
  }

  /** The programme is business-wide, so only members who see every store may change it. */
  setSettings(auth: AuthContext, settings: LoyaltySettings): Promise<LoyaltySettings> {
    if (!auth.allStores) {
      throw new ForbiddenException('Only members who work at every store can change the programme');
    }
    const values = {
      ...settings,
      tiers: [...settings.tiers].sort((a, b) => a.minPoints - b.minPoints),
    };
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await tx
        .insert(loyaltySettings)
        .values({ organizationId: auth.organization.id, ...values })
        .onConflictDoUpdate({
          target: loyaltySettings.organizationId,
          set: { ...values, updatedAt: sql`now()` },
        });
      return loyaltySettingsOf(tx, auth.organization.id);
    });
  }

  // Helpers -----------------------------------------------------------------

  /** The party, if the member can see it (404 otherwise); locked when changing its points. */
  private async party(
    tx: Transaction,
    auth: AuthContext,
    partyId: string,
    lock = false,
  ): Promise<PartyRow> {
    const query = tx
      .select({ id: parties.id, name: parties.displayName, homeStoreId: parties.homeStoreId })
      .from(parties)
      .where(eq(parties.id, partyId));
    const [party] = lock ? await query.for('update') : await query;
    if (!party || !canSeeParty(auth, party)) throw new NotFoundException('Party not found');
    return party;
  }

  private async account(tx: Transaction, partyId: string): Promise<AccountRow> {
    const [account] = await tx
      .select()
      .from(loyaltyAccounts)
      .where(eq(loyaltyAccounts.partyId, partyId))
      .for('update');
    if (!account) throw new NotFoundException('This party has no loyalty account');
    return account;
  }

  /** Writes off expired points first, so they cannot be spent, then checks the balance. */
  private async requireBalance(
    tx: Transaction,
    auth: AuthContext,
    account: AccountRow,
    points: number,
  ): Promise<void> {
    await expireAccount(tx, auth.organization.id, account.id, todayInIndia());
    const entries = await entriesOf(tx, auth.organization.id, account.id);
    const balance = entries.reduce((total, entry) => total + entry.points, 0);
    if (points > balance) {
      throw new ConflictException(`Only ${String(balance)} points are available`);
    }
  }

  /**
   * Locks the party and its active account, writes one ledger entry, and tells
   * the account's salesperson when the party reaches a new tier.
   */
  private post(
    auth: AuthContext,
    partyId: string,
    work: (account: AccountRow, settings: LoyaltySettings, tx: Transaction) => Promise<NewEntry>,
  ): Promise<LoyaltyView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const organizationId = auth.organization.id;
      const party = await this.party(tx, auth, partyId, true);
      const account = await this.account(tx, partyId);
      if (account.status === 'closed')
        throw new ConflictException('This loyalty account is closed');
      const settings = await loyaltySettingsOf(tx, organizationId);
      const today = todayInIndia();
      const before = await loyaltySummaryOf(tx, organizationId, partyId, today);
      const entry = await work(account, settings, tx);
      await tx.insert(loyaltyLedger).values({
        ...entry,
        organizationId,
        accountId: account.id,
        // Every entry that adds points is a lot that expires, if points expire.
        expiresOn:
          entry.points > 0 && settings.expiryDays !== null
            ? addDays(today, settings.expiryDays)
            : null,
        createdByMemberId: auth.memberId,
      });
      const view = await this.view(tx, auth, party);
      if (view.tier && view.tier.name !== before.tier?.name && account.assignedMemberId) {
        await this.notifier.notify(tx, {
          organizationId,
          event: 'loyalty_tier_reached',
          to: { memberIds: [account.assignedMemberId] },
          actorMemberId: auth.memberId,
          title: `${party.name} reached ${view.tier.name}`,
          body: `${String(view.totalEarned)} points earned, ${String(view.balance)} to spend`,
          link: `/parties/${party.id}`,
        });
      }
      return view;
    });
  }

  private async view(
    tx: Transaction,
    auth: AuthContext,
    party: PartyRow,
    page: { limit: number; offset: number } = { limit: 20, offset: 0 },
  ): Promise<LoyaltyView> {
    const summary = await loyaltySummaryOf(tx, auth.organization.id, party.id, todayInIndia());
    const accountId = summary.account?.id ?? null;
    const rows = accountId
      ? await tx
          .select({ entry: loyaltyLedger, createdByName: users.fullName })
          .from(loyaltyLedger)
          .leftJoin(
            organizationMembers,
            eq(organizationMembers.id, loyaltyLedger.createdByMemberId),
          )
          .leftJoin(users, eq(users.id, organizationMembers.userId))
          .where(eq(loyaltyLedger.accountId, accountId))
          .orderBy(desc(loyaltyLedger.createdAt), desc(loyaltyLedger.id))
          .limit(page.limit)
          .offset(page.offset)
      : [];
    return {
      ...summary,
      party: { id: party.id, name: party.name },
      ledger: {
        items: rows.map(({ entry, createdByName }) => ({
          id: entry.id,
          kind: entry.kind,
          points: entry.points,
          manualPurchasePaise: entry.manualPurchasePaise,
          reference: entry.reference,
          note: entry.note,
          expiresOn: entry.expiresOn,
          createdBy: entry.createdByMemberId
            ? { memberId: entry.createdByMemberId, name: String(createdByName) }
            : null,
          createdAt: entry.createdAt.toISOString(),
        })),
        total: await this.ledgerCount(tx, accountId),
      },
    };
  }

  private async ledgerCount(tx: Transaction, accountId: string | null): Promise<number> {
    if (accountId === null) return 0;
    const [totals] = await tx
      .select({ total: count() })
      .from(loyaltyLedger)
      .where(eq(loyaltyLedger.accountId, accountId));
    return Number(totals?.total);
  }
}
