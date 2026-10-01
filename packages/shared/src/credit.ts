import { assertPaise } from './money.js';

/**
 * A business's credit rules (spec §3.22). Utilisation is what the party would
 * owe after the sale, as a share of its limit.
 */
export interface CreditRules {
  /** Up to this much of the limit, sell normally (default 80 %). */
  readonly normalUpToPercent: number;
  /** Up to this much, a manager approves; above it, the owner (default 100 %). */
  readonly managerUpToPercent: number;
  /** Overdue for more than this many days blocks credit (default 30). */
  readonly holdAfterOverdueDays: number;
}

export const DEFAULT_CREDIT_RULES: CreditRules = {
  normalUpToPercent: 80,
  managerUpToPercent: 100,
  holdAfterOverdueDays: 30,
};

export type CreditStatus = 'none' | 'active' | 'on_hold';
export type CreditDecision = 'allowed' | 'manager_approval' | 'owner_approval' | 'blocked';
export type CreditBlock = 'no_credit' | 'on_hold' | 'overdue';

/** Where a party stands: its credit status and limit, what it owes and how late. */
export interface CreditPosition {
  readonly status: CreditStatus;
  readonly limitPaise: number;
  readonly exposurePaise: number;
  readonly overdueDays: number;
}

export interface CreditCheck {
  readonly decision: CreditDecision;
  /** Why it is blocked; null unless the decision is "blocked". */
  readonly blockedBecause: CreditBlock | null;
  /** What the party would owe after this sale. */
  readonly projectedExposurePaise: number;
  /** Limit left after this sale; negative when over the limit. */
  readonly availablePaise: number;
  /** Projected exposure as a percentage of the limit (2 decimals); null without a limit. */
  readonly utilizationPercent: number | null;
}

/**
 * Decides whether a sale of `amountPaise` on credit may go ahead (spec §3.22):
 * blocked without credit, on hold, or overdue beyond the threshold; otherwise
 * by utilisation — normal, manager approval, or owner approval. Leave out the
 * amount to see where the party stands now.
 */
export function checkCredit(
  rules: CreditRules,
  position: CreditPosition,
  amountPaise = 0,
): CreditCheck {
  assertPaise(amountPaise);
  const projected = position.exposurePaise + amountPaise;
  const figures = {
    projectedExposurePaise: projected,
    availablePaise: position.limitPaise - projected,
    utilizationPercent:
      position.limitPaise > 0 ? Math.round((projected * 10_000) / position.limitPaise) / 100 : null,
  };
  const blocked = (reason: CreditBlock): CreditCheck => ({
    decision: 'blocked',
    blockedBecause: reason,
    ...figures,
  });
  if (position.status === 'none') return blocked('no_credit');
  if (position.status === 'on_hold') return blocked('on_hold');
  if (position.overdueDays > rules.holdAfterOverdueDays) return blocked('overdue');
  // Exact integer comparison: projected / limit <= percent / 100.
  const within = (percent: number) =>
    BigInt(projected) * 100n <= BigInt(position.limitPaise) * BigInt(percent);
  const decision: CreditDecision = within(rules.normalUpToPercent)
    ? 'allowed'
    : within(rules.managerUpToPercent)
      ? 'manager_approval'
      : 'owner_approval';
  return { decision, blockedBecause: null, ...figures };
}
