import { assertPaise } from './money.js';
import type { AgeingBucket } from './receivables/ageing.js';

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
  /** Released from a hold with approval: overdue days do not block (P2-M09). */
  readonly overdueWaived?: boolean;
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
  if (position.overdueWaived !== true && position.overdueDays > rules.holdAfterOverdueDays) {
    return blocked('overdue');
  }
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

// Credit enforcement (P2-M09, docs/mvp-3/credit-and-receivables.md §4) ---------

const DECISION_RANK: Readonly<Record<CreditDecision, number>> = {
  allowed: 0,
  manager_approval: 1,
  owner_approval: 2,
  blocked: 3,
};

/** The stricter of two checks (allowed < manager < owner < blocked); the first on a tie. */
export function stricterCheck(first: CreditCheck, second: CreditCheck): CreditCheck {
  return DECISION_RANK[second.decision] > DECISION_RANK[first.decision] ? second : first;
}

/** Who must approve a sale past the rules. */
export type CreditApprovalLevel = 'manager' | 'owner';

const LEVEL_RANK: Readonly<Record<CreditApprovalLevel, number>> = { manager: 1, owner: 2 };

/** Whether an approval at `approved` is enough for a sale needing `needed`. */
export function levelCovers(approved: CreditApprovalLevel, needed: CreditApprovalLevel): boolean {
  return LEVEL_RANK[approved] >= LEVEL_RANK[needed];
}

/** The ageing bucket (receivables/ageing.ts) for a number of days past the due date. */
export function ageingBucket(daysPastDue: number): AgeingBucket {
  if (daysPastDue < 0) return 'not_due';
  if (daysPastDue <= 30) return 'days_0_30';
  if (daysPastDue <= 60) return 'days_31_60';
  if (daysPastDue <= 90) return 'days_61_90';
  return 'days_90_plus';
}
