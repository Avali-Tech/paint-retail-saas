import { schema, type Transaction } from '@paint/db';
import { sql } from 'drizzle-orm';

const { creditProfiles } = schema;

/** Up to ₹10 crore of credit (credit.schemas.ts `limit`); exposures may exceed it. */
export const MAX_CREDIT_LIMIT_PAISE = 10_000_000_000;
/** Days a party may have to pay (credit.schemas.ts `days`). */
export const MAX_CREDIT_DAYS = 365;

/**
 * Gives a party a credit limit and days, approved by `memberId`: an approved
 * credit request, or an approver's parties import (PO-101). A party on hold
 * stays on hold. The audit log records the change (trigger on credit_profiles).
 */
export async function setCreditTerms(
  tx: Transaction,
  organizationId: string,
  partyId: string,
  terms: { readonly limitPaise: number; readonly creditDays: number },
  memberId: string,
): Promise<void> {
  const values = {
    limitPaise: terms.limitPaise,
    creditDays: terms.creditDays,
    approvedByMemberId: memberId,
    approvedAt: sql`now()`,
  };
  await tx
    .insert(creditProfiles)
    .values({ organizationId, partyId, status: 'active', ...values })
    .onConflictDoUpdate({
      target: creditProfiles.partyId,
      set: {
        ...values,
        status: sql`case when ${creditProfiles.status} = 'on_hold' then 'on_hold'::credit_status else 'active'::credit_status end`,
        updatedAt: sql`now()`,
      },
    });
}
