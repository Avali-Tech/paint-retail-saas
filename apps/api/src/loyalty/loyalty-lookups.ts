import { schema, type Transaction } from '@paint/db';
import { pointLots, tierFor, type LoyaltyTier } from '@paint/shared';
import { and, asc, eq } from 'drizzle-orm';

const { loyaltyAccounts, loyaltyLedger, loyaltySettings, organizationMembers, users } = schema;

export interface LoyaltySettings {
  readonly earnPoints: number;
  readonly earnPerPaise: number;
  readonly tiers: LoyaltyTier[];
  readonly expiryDays: number | null;
  readonly minRedemptionPoints: number;
}

/** 1 point per ₹100, no tiers, points never expire, any amount redeemable. */
export const DEFAULT_LOYALTY_SETTINGS: LoyaltySettings = {
  earnPoints: 1,
  earnPerPaise: 10_000,
  tiers: [],
  expiryDays: null,
  minRedemptionPoints: 0,
};

/** The business's loyalty programme; the defaults until someone sets it. */
export async function loyaltySettingsOf(
  tx: Transaction,
  organizationId: string,
): Promise<LoyaltySettings> {
  const [settings] = await tx
    .select({
      earnPoints: loyaltySettings.earnPoints,
      earnPerPaise: loyaltySettings.earnPerPaise,
      tiers: loyaltySettings.tiers,
      expiryDays: loyaltySettings.expiryDays,
      minRedemptionPoints: loyaltySettings.minRedemptionPoints,
    })
    .from(loyaltySettings)
    .where(eq(loyaltySettings.organizationId, organizationId));
  return settings ?? DEFAULT_LOYALTY_SETTINGS;
}

/** A party's points, all worked out from its ledger. */
export interface LoyaltySummary {
  /** Null until the party is enrolled. */
  readonly account: {
    readonly id: string;
    readonly status: (typeof schema.loyaltyStatus.enumValues)[number];
    readonly assignedTo: { readonly memberId: string; readonly name: string } | null;
    readonly createdAt: string;
  } | null;
  /** The sum of every ledger entry. */
  readonly balance: number;
  /** Every point ever added; tiers go by this. */
  readonly totalEarned: number;
  readonly totalRedeemed: number;
  readonly tier: LoyaltyTier | null;
  readonly nextTier: (LoyaltyTier & { readonly pointsToGo: number }) | null;
  /** The next points to expire, if any. */
  readonly nextExpiry: { readonly points: number; readonly expiresOn: string } | null;
}

/** The ledger of one account, oldest first; filtered by business explicitly for the worker. */
export const entriesOf = (tx: Transaction, organizationId: string, accountId: string) =>
  tx
    .select({
      kind: loyaltyLedger.kind,
      points: loyaltyLedger.points,
      expiresOn: loyaltyLedger.expiresOn,
    })
    .from(loyaltyLedger)
    .where(
      and(eq(loyaltyLedger.organizationId, organizationId), eq(loyaltyLedger.accountId, accountId)),
    )
    .orderBy(asc(loyaltyLedger.createdAt), asc(loyaltyLedger.id));

export async function loyaltySummaryOf(
  tx: Transaction,
  organizationId: string,
  partyId: string,
  today: string,
): Promise<LoyaltySummary> {
  const [row] = await tx
    .select({
      id: loyaltyAccounts.id,
      status: loyaltyAccounts.status,
      assignedMemberId: loyaltyAccounts.assignedMemberId,
      assigneeName: users.fullName,
      createdAt: loyaltyAccounts.createdAt,
    })
    .from(loyaltyAccounts)
    .leftJoin(organizationMembers, eq(organizationMembers.id, loyaltyAccounts.assignedMemberId))
    .leftJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(loyaltyAccounts.partyId, partyId));
  const entries = row ? await entriesOf(tx, organizationId, row.id) : [];
  const sum = (keep: (entry: (typeof entries)[number]) => boolean) =>
    entries.filter(keep).reduce((total, entry) => total + entry.points, 0);
  const totalEarned = sum((entry) => entry.points > 0);
  const { tiers } = await loyaltySettingsOf(tx, organizationId);
  const { current, next } = tierFor(totalEarned, tiers);
  return {
    account: row
      ? {
          id: row.id,
          status: row.status,
          assignedTo: row.assignedMemberId
            ? { memberId: row.assignedMemberId, name: String(row.assigneeName) }
            : null,
          createdAt: row.createdAt.toISOString(),
        }
      : null,
    balance: sum(() => true),
    totalEarned,
    // 0 - x, not -x: no negative zero.
    totalRedeemed: 0 - sum((entry) => entry.kind === 'redeem'),
    tier: current,
    nextTier: next,
    nextExpiry: pointLots(entries, today).nextExpiry,
  };
}

/**
 * Writes off the account's expired, unused points (one "expire" entry) and
 * returns how many. Call with the account locked.
 */
export async function expireAccount(
  tx: Transaction,
  organizationId: string,
  accountId: string,
  today: string,
): Promise<number> {
  const { expired } = pointLots(await entriesOf(tx, organizationId, accountId), today);
  if (expired > 0) {
    await tx.insert(loyaltyLedger).values({
      organizationId,
      accountId,
      kind: 'expire',
      points: -expired,
      note: 'Points expired unused',
    });
  }
  return expired;
}
