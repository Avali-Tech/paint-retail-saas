import { schema, type Transaction } from '@paint/db';
import { eq } from 'drizzle-orm';
import type { SaleSubject } from '../credit/credit-gate.js';
import { billingLiveOn } from '../credit/credit-lookups.js';
import type { TaxDocumentRow } from './invoice-view.js';

const { partyBalances, salesOrders } = schema;

/**
 * A draft invoice as a sale on credit of what stays unpaid at issue (MVP 3
 * spec §4.2), or null when it is not credit: before go-live, a walk-in bill, a
 * bill of a postpaid order (checked at confirm), or one paid in full with the
 * issue (payments and, when asked, the customer's advances).
 */
export async function invoiceCreditSubject(
  tx: Transaction,
  document: TaxDocumentRow,
  totalPaise: number,
  issue: {
    readonly payments?: readonly { readonly amountPaise: number }[] | undefined;
    readonly allocateAdvances: boolean;
  },
): Promise<SaleSubject | null> {
  const partyId = document.partyId;
  if (partyId === null || (await billingLiveOn(tx)) === null) return null;
  if (document.salesOrderId !== null) {
    const [order] = (await tx
      .select({ terms: salesOrders.paymentTerms })
      .from(salesOrders)
      .where(eq(salesOrders.id, document.salesOrderId))) as [{ terms: string }];
    if (order.terms === 'postpaid') return null;
  }
  const paying = (issue.payments ?? []).reduce((sum, item) => sum + item.amountPaise, 0);
  const [balance] = await tx
    .select({ advance: partyBalances.advancePaise })
    .from(partyBalances)
    .where(eq(partyBalances.partyId, partyId));
  const advances = issue.allocateAdvances ? Math.min(balance?.advance ?? 0, totalPaise) : 0;
  if (totalPaise - advances - paying <= 0) return null;
  // Advances are already netted in the balance: the exposure grows by the bill less what is paid now.
  return {
    type: 'tax_document',
    id: document.id,
    partyId,
    projectId: document.projectId,
    storeId: document.storeId,
    amountPaise: totalPaise - paying,
    excludeOrderId: null,
  };
}
