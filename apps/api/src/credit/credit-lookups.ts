import { schema, type Transaction } from '@paint/db';
import {
  DEFAULT_CREDIT_RULES,
  checkCredit,
  type CreditCheck,
  type CreditRules,
  type MemberAccess,
} from '@paint/shared';
import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';

const { creditProfiles, creditRequests, creditRules, parties } = schema;

type ProfileRow = typeof creditProfiles.$inferSelect;

/** The business's credit rules; the defaults until someone sets them. */
export async function creditRulesOf(tx: Transaction, organizationId: string): Promise<CreditRules> {
  const [rules] = await tx
    .select({
      normalUpToPercent: creditRules.normalUpToPercent,
      managerUpToPercent: creditRules.managerUpToPercent,
      holdAfterOverdueDays: creditRules.holdAfterOverdueDays,
    })
    .from(creditRules)
    .where(eq(creditRules.organizationId, organizationId));
  return rules ?? DEFAULT_CREDIT_RULES;
}

/** Where a party stands, with its current check (no sale). */
export interface CreditSummary {
  readonly status: ProfileRow['status'];
  readonly limitPaise: number;
  readonly creditDays: number;
  readonly risk: ProfileRow['risk'];
  /** Entered by hand until billing exists (Release 2.0). */
  readonly manualExposurePaise: number;
  readonly overdueDays: number;
  readonly check: CreditCheck;
  readonly pendingRequest: {
    readonly id: string;
    readonly number: string;
    readonly limitPaise: number;
    readonly creditDays: number;
  } | null;
}

/** A party without a profile: no credit. */
const NO_CREDIT = {
  status: 'none',
  limitPaise: 0,
  creditDays: 0,
  risk: 'low',
  manualExposurePaise: 0,
  overdueDays: 0,
} as const;

export async function creditSummaryOf(
  tx: Transaction,
  organizationId: string,
  partyId: string,
): Promise<CreditSummary> {
  const [row] = await tx.select().from(creditProfiles).where(eq(creditProfiles.partyId, partyId));
  const profile = row ?? NO_CREDIT;
  const [pending] = await tx
    .select({
      id: creditRequests.id,
      number: creditRequests.number,
      limitPaise: creditRequests.limitPaise,
      creditDays: creditRequests.creditDays,
    })
    .from(creditRequests)
    .where(and(eq(creditRequests.partyId, partyId), eq(creditRequests.status, 'pending')));
  return {
    status: profile.status,
    limitPaise: profile.limitPaise,
    creditDays: profile.creditDays,
    risk: profile.risk,
    manualExposurePaise: profile.manualExposurePaise,
    overdueDays: profile.overdueDays,
    check: checkCredit(await creditRulesOf(tx, organizationId), {
      status: profile.status,
      limitPaise: profile.limitPaise,
      exposurePaise: profile.manualExposurePaise,
      overdueDays: profile.overdueDays,
    }),
    pendingRequest: pending ?? null,
  };
}

/** Business-wide parties, and those of the member's stores. */
export function visibleParties(access: MemberAccess): SQL | undefined {
  return access.allStores
    ? undefined
    : or(isNull(parties.homeStoreId), inArray(parties.homeStoreId, [...access.storeIds]));
}
