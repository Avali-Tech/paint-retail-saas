import { ConflictException } from '@nestjs/common';
import { releaseStock, schema, type Transaction } from '@paint/db';
import { OPEN_ORDER_STATUSES, orderStatusFor } from '@paint/shared';
import { eq, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import type { TaxDocumentRow } from '../billing/invoice-view.js';
import { addDays } from '../contracts/contract-dates.js';
import { holdStock, heldByLine } from './order-stock.js';
import type { SalesOrderLineRow, SalesOrderRow } from './order-views.js';

const { creditProfiles, salesOrderLines, salesOrders, salesSettings, taxDocumentLines } = schema;

/** Thousandths, so quantities (at most 3 decimals) add up exactly. */
const milli = (quantity: number) => Math.round(quantity * 1000);

/** What issuing an invoice from an order changes about the issue. */
export interface OrderIssue {
  /** False with `stock_post_on = dispatch`: the goods are billed now and leave on dispatch. */
  readonly postStock: boolean;
  /** Postpaid and partial orders: due after the party's credit days; null keeps the default. */
  readonly dueOn: string | null;
  /** A prepaid order's invoice is paid in full at issue (spec §4.4). */
  readonly prepaid: boolean;
}

/** The order an invoice bills, locked, with its lines locked too. */
async function lockedOrder(tx: Transaction, orderId: string) {
  const [order] = (await tx
    .select()
    .from(salesOrders)
    .where(eq(salesOrders.id, orderId))
    .for('update')) as [SalesOrderRow];
  const lines: SalesOrderLineRow[] = await tx
    .select()
    .from(salesOrderLines)
    .where(eq(salesOrderLines.orderId, orderId))
    .orderBy(salesOrderLines.lineNo)
    .for('update');
  return { order, lines };
}

/** Units of each order line the invoice bills (its lines that name one). */
async function billedLines(tx: Transaction, invoiceId: string) {
  return tx
    .select({
      orderLineId: taxDocumentLines.orderLineId,
      variantId: taxDocumentLines.variantId,
      quantity: taxDocumentLines.quantity,
    })
    .from(taxDocumentLines)
    .where(eq(taxDocumentLines.documentId, invoiceId))
    .orderBy(taxDocumentLines.lineNo);
}

async function setBilled(
  tx: Transaction,
  order: SalesOrderRow,
  lines: readonly SalesOrderLineRow[],
): Promise<void> {
  for (const line of lines) {
    await tx
      .update(salesOrderLines)
      .set({
        quantityInvoiced: line.quantityInvoiced,
        quantityCancelled: line.quantityCancelled,
      })
      .where(eq(salesOrderLines.id, line.id));
  }
  if (OPEN_ORDER_STATUSES.includes(order.status) || order.status === 'fulfilled') {
    const status = orderStatusFor(lines);
    if (status !== order.status) {
      await tx
        .update(salesOrders)
        .set({ status, updatedAt: sql`now()` })
        .where(eq(salesOrders.id, order.id));
    }
  }
}

/**
 * Bills order lines with an invoice being issued (spec §4.2, §4.4), in the
 * issuing transaction: each invoice line names an open line of the order,
 * fulfilled from the invoice's store, for at most what is still open. With
 * stock out on invoice, the reservation is consumed (the issue then takes
 * the stock out); with stock out on dispatch, the billed units stay held for
 * the customer. The order's lines and status move on.
 */
export async function issueAgainstOrder(
  tx: Transaction,
  auth: AuthContext,
  invoice: TaxDocumentRow,
  today: string,
): Promise<OrderIssue> {
  const { order, lines } = await lockedOrder(tx, String(invoice.salesOrderId));
  if (!OPEN_ORDER_STATUSES.includes(order.status)) {
    throw new ConflictException(
      `Sales order ${order.number} is ${order.status}: it cannot be billed`,
    );
  }
  const billed = new Map<string, number>();
  for (const item of await billedLines(tx, invoice.id)) {
    const line = lines.find((candidate) => candidate.id === item.orderLineId);
    if (line?.variantId !== item.variantId || line.fulfilStoreId !== invoice.storeId) {
      throw new ConflictException(
        `Every line of this bill must be a line of ${order.number} fulfilled from this store`,
      );
    }
    billed.set(line.id, (billed.get(line.id) ?? 0) + milli(item.quantity));
  }
  const [settings] = await tx
    .select({ stockPostOn: salesSettings.stockPostOn })
    .from(salesSettings);
  const postStock = settings?.stockPostOn !== 'dispatch';
  const held = await heldByLine(
    tx,
    lines.map((line) => line.id),
  );
  const updated = [];
  for (const line of lines) {
    const units = billed.get(line.id) ?? 0;
    const open =
      milli(line.quantity) - milli(line.quantityInvoiced) - milli(line.quantityCancelled);
    if (units > open) {
      throw new ConflictException(
        `Line ${String(line.lineNo)} of ${order.number} has only ${String(open / 1000)} left to bill`,
      );
    }
    if (units > 0 && postStock) {
      await releaseStock(tx, [
        {
          orderLineId: line.id,
          quantity: units / 1000,
          consumedBy: { type: 'tax_document', id: invoice.id },
        },
      ]);
    } else if (units > milli(held(line.id))) {
      // Held for the customer until dispatch: top the reservation up to what is billed.
      await holdStock(tx, auth, [{ line, storeId: line.fulfilStoreId, quantity: units / 1000 }]);
    }
    updated.push({ ...line, quantityInvoiced: (milli(line.quantityInvoiced) + units) / 1000 });
  }
  await setBilled(tx, order, updated);

  let dueOn: string | null = null;
  if (order.paymentTerms !== 'prepaid') {
    const [profile] = await tx
      .select({ creditDays: creditProfiles.creditDays })
      .from(creditProfiles)
      .where(eq(creditProfiles.partyId, order.billToPartyId));
    dueOn = addDays(today, profile?.creditDays ?? 0);
  }
  return { postStock, dueOn, prepaid: order.paymentTerms === 'prepaid' };
}

/**
 * Gives an order back the units a same-day cancelled invoice billed: open
 * again on a live order (re-reserve them with POST /sales-orders/:id/reserve),
 * cancelled on a cancelled or closed one. Runs in the cancelling transaction.
 */
export async function cancelAgainstOrder(tx: Transaction, invoice: TaxDocumentRow): Promise<void> {
  const { order, lines } = await lockedOrder(tx, String(invoice.salesOrderId));
  const items = await billedLines(tx, invoice.id);
  const ended = order.status === 'cancelled' || order.status === 'closed';
  const updated = lines.map((line) => {
    const units = items
      .filter((item) => item.orderLineId === line.id)
      .reduce((sum, item) => sum + milli(item.quantity), 0);
    return {
      ...line,
      quantityInvoiced: (milli(line.quantityInvoiced) - units) / 1000,
      quantityCancelled: (milli(line.quantityCancelled) + (ended ? units : 0)) / 1000,
    };
  });
  await setBilled(tx, order, updated);
}

/** True when goods have left on a dispatch of this invoice. */
export async function hasDispatches(tx: Transaction, invoiceId: string): Promise<boolean> {
  const result = await tx.execute(
    sql`select 1 from dispatches d where d.invoice_id = ${invoiceId} limit 1`,
  );
  return result.rows.length > 0;
}
