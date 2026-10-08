import { schema, type Transaction } from '@paint/db';
import { checkCredit, creditApprovalFor, type OrderCreditView } from '@paint/shared';
import { eq } from 'drizzle-orm';
import { creditRulesOf, exposureOf } from '../credit/credit-lookups.js';
import type { SalesOrderRow } from './order-views.js';

const { creditProfiles } = schema;

/** A party without a credit profile: no credit. */
const NO_PROFILE = {
  status: 'none',
  limitPaise: 0,
  manualExposurePaise: 0,
  overdueDays: 0,
  openingOverdueSince: null,
} as const;

/**
 * Where the order's bill-to party stands for credit (spec §4.4, §4.7): its
 * exposure without this order, and — for a postpaid order — checkCredit for
 * the order's total with the approval it needs.
 */
export async function orderCredit(
  tx: Transaction,
  organizationId: string,
  order: SalesOrderRow,
): Promise<OrderCreditView> {
  const [profile = NO_PROFILE] = await tx
    .select({
      status: creditProfiles.status,
      limitPaise: creditProfiles.limitPaise,
      manualExposurePaise: creditProfiles.manualExposurePaise,
      overdueDays: creditProfiles.overdueDays,
      openingOverdueSince: creditProfiles.openingOverdueSince,
    })
    .from(creditProfiles)
    .where(eq(creditProfiles.partyId, order.billToPartyId));
  const exposure = await exposureOf(tx, order.billToPartyId, profile, order.id);
  const position = {
    status: profile.status,
    limitPaise: profile.limitPaise,
    exposurePaise: exposure.exposurePaise,
    overdueDays: exposure.overdueDays,
  };
  if (order.paymentTerms !== 'postpaid') {
    return {
      required: false,
      exposureSource: exposure.source,
      position,
      check: null,
      approval: 'none',
    };
  }
  const check = checkCredit(await creditRulesOf(tx, organizationId), position, order.totalPaise);
  return {
    required: true,
    exposureSource: exposure.source,
    position,
    check,
    approval: creditApprovalFor(check.decision),
  };
}
