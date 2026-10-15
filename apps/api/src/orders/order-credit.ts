import type { Transaction } from '@paint/db';
import type { OrderCreditView } from '@paint/shared';
import { saleCredit, type SaleSubject } from '../credit/credit-gate.js';
import type { SalesOrderRow } from './order-views.js';

/** The order as a sale on credit: its bill-to party, site, store and total. */
export function orderSubject(order: SalesOrderRow): SaleSubject {
  return {
    type: 'sales_order',
    id: order.id,
    partyId: order.billToPartyId,
    projectId: order.projectId,
    storeId: order.storeId,
    amountPaise: order.totalPaise,
    excludeOrderId: order.id,
  };
}

/**
 * Where the order's bill-to party (and its site account) stands for credit
 * (MVP 2 spec §4.4, MVP 3 spec §4.2): its exposure without this order, and —
 * for a postpaid order — checkCredit for the order's total with the approval
 * it needs.
 */
export function orderCredit(
  tx: Transaction,
  organizationId: string,
  order: SalesOrderRow,
): Promise<OrderCreditView> {
  return saleCredit(tx, organizationId, orderSubject(order), order.paymentTerms === 'postpaid');
}
