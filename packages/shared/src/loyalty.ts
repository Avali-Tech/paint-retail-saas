import { assertPaise } from './money.js';

/** `earnPoints` points for every `earnPerPaise` spent, e.g. 1 point per ₹100 (10,000 paise). */
export interface EarnRate {
  readonly earnPoints: number;
  readonly earnPerPaise: number;
}

/** A tier, reached at `minPoints` lifetime points earned. */
export interface LoyaltyTier {
  readonly name: string;
  readonly minPoints: number;
}

/** Points earned on a purchase, rounded down, in exact integer arithmetic. */
export function pointsForPurchase(amountPaise: number, rate: EarnRate): number {
  assertPaise(amountPaise);
  if (amountPaise <= 0) return 0;
  return Number((BigInt(amountPaise) * BigInt(rate.earnPoints)) / BigInt(rate.earnPerPaise));
}

/** The tier reached with `earnedPoints`, and the next one with how far away it is. */
export function tierFor(
  earnedPoints: number,
  tiers: readonly LoyaltyTier[],
): {
  readonly current: LoyaltyTier | null;
  readonly next: (LoyaltyTier & { readonly pointsToGo: number }) | null;
} {
  const sorted = [...tiers].sort((a, b) => a.minPoints - b.minPoints);
  const reached = sorted.filter((tier) => tier.minPoints <= earnedPoints);
  const next = sorted.find((tier) => tier.minPoints > earnedPoints);
  return {
    current: reached.at(-1) ?? null,
    next: next ? { ...next, pointsToGo: next.minPoints - earnedPoints } : null,
  };
}

/** A ledger entry, as far as expiry is concerned. */
export interface PointsEntry {
  readonly points: number;
  /** Set on entries that add points, when points expire. */
  readonly expiresOn: string | null;
}

/**
 * Which points have expired by `today` (YYYY-MM-DD) and which expire next.
 * Every entry that adds points is a lot; everything taken away (redemptions,
 * negative adjustments, earlier expiries) uses the soonest-expiring lots first,
 * and lots without expiry last. A lot expires at the end of its `expiresOn` day.
 */
export function pointLots(
  entries: readonly PointsEntry[],
  today: string,
): {
  /** Unused points in lots that have expired, not yet written off. */
  readonly expired: number;
  /** The soonest unused, unexpired lot that will expire. */
  readonly nextExpiry: { readonly points: number; readonly expiresOn: string } | null;
  /** Every lot with unused, unexpired points, soonest-expiring first (null = never expires). */
  readonly unused: { readonly points: number; readonly expiresOn: string | null }[];
} {
  const never = '9999-12-31';
  const lots = entries
    .filter((entry) => entry.points > 0)
    .map((entry, order) => ({ ...entry, order }))
    .sort(
      (a, b) => (a.expiresOn ?? never).localeCompare(b.expiresOn ?? never) || a.order - b.order,
    );
  let used = -entries.filter((entry) => entry.points < 0).reduce((sum, e) => sum + e.points, 0);
  let expired = 0;
  let nextExpiry: { points: number; expiresOn: string } | null = null;
  const unused: { points: number; expiresOn: string | null }[] = [];
  for (const lot of lots) {
    const fromLot = Math.min(lot.points, used);
    used -= fromLot;
    const left = lot.points - fromLot;
    if (left === 0) continue;
    if (lot.expiresOn === null || lot.expiresOn >= today) {
      unused.push({ points: left, expiresOn: lot.expiresOn });
    }
    if (lot.expiresOn === null) continue;
    if (lot.expiresOn < today) {
      expired += left;
    } else if (nextExpiry === null) {
      nextExpiry = { points: left, expiresOn: lot.expiresOn };
    } else if (nextExpiry.expiresOn === lot.expiresOn) {
      nextExpiry.points += left;
    }
  }
  return { expired, nextExpiry, unused };
}
