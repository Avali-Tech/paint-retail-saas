import { nextDocumentNumber, schema, type Transaction } from '@paint/db';
import { SALES_ORDER_NUMBER_PREFIX, formatDocumentNumber, type PaymentTerms } from '@paint/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { fieldError } from '../tax/tax-lookups.js';
import type { SalesOrderRow } from './order-views.js';
import { priceHeader, pricedColumns, saleHeader, type SaleHeaderInput } from './sale-header.js';
import type { SaleLineInput } from './sale-pricing.js';

const { salesOrderLines, salesOrders, stores } = schema;

/** A sales order as a request or a converted quotation gives it. */
export interface OrderDraftInput extends SaleHeaderInput {
  readonly paymentTerms: PaymentTerms;
  readonly lines: readonly (SaleLineInput & { readonly fulfilStoreId?: string | null })[];
}

/** The order checked and priced at `today`, and the fulfil store of each line. */
async function pricedOrder(
  tx: Transaction,
  auth: AuthContext,
  input: OrderDraftInput,
  today: string,
) {
  const { header, billTo } = await saleHeader(tx, auth, input);
  const fulfilStores = input.lines.map((line) => line.fulfilStoreId ?? input.storeId);
  const unique = [...new Set(fulfilStores)];
  const active = await tx
    .select({ id: stores.id })
    .from(stores)
    .where(and(inArray(stores.id, unique), eq(stores.isActive, true)));
  const unknown = fulfilStores.findIndex((id) => !active.some((store) => store.id === id));
  if (unknown !== -1) throw fieldError(`lines.${String(unknown)}.fulfilStoreId`, 'Unknown store');
  const priced = await priceHeader(
    tx,
    header,
    billTo,
    input.billDiscount ?? null,
    input.lines,
    today,
  );
  return { header: pricedColumns(header, priced), priced, fulfilStores };
}

async function writeLines(
  tx: Transaction,
  auth: AuthContext,
  orderId: string,
  order: Awaited<ReturnType<typeof pricedOrder>>,
): Promise<void> {
  await tx.insert(salesOrderLines).values(
    order.priced.lines.map((line, index) => ({
      ...line,
      organizationId: auth.organization.id,
      orderId,
      fulfilStoreId: String(order.fulfilStores[index]),
    })),
  );
}

/** A new draft sales order (direct, or from `quotationId`), numbered `SO-000017`. */
export async function insertOrder(
  tx: Transaction,
  auth: AuthContext,
  input: OrderDraftInput,
  today: string,
  quotationId: string | null,
): Promise<SalesOrderRow> {
  const order = await pricedOrder(tx, auth, input, today);
  const number = formatDocumentNumber(
    SALES_ORDER_NUMBER_PREFIX,
    await nextDocumentNumber(tx, auth.organization.id, 'sales_order'),
  );
  const [row] = (await tx
    .insert(salesOrders)
    .values({
      ...order.header,
      organizationId: auth.organization.id,
      number,
      paymentTerms: input.paymentTerms,
      quotationId,
      createdByMemberId: auth.memberId,
    })
    .returning()) as [SalesOrderRow];
  await writeLines(tx, auth, row.id, order);
  return row;
}

/** Replaces a draft order's header and lines, priced again at `today`. */
export async function replaceOrder(
  tx: Transaction,
  auth: AuthContext,
  id: string,
  input: OrderDraftInput,
  today: string,
): Promise<SalesOrderRow> {
  const order = await pricedOrder(tx, auth, input, today);
  const [row] = (await tx
    .update(salesOrders)
    .set({ ...order.header, paymentTerms: input.paymentTerms, updatedAt: sql`now()` })
    .where(eq(salesOrders.id, id))
    .returning()) as [SalesOrderRow];
  await tx.delete(salesOrderLines).where(eq(salesOrderLines.orderId, id));
  await writeLines(tx, auth, id, order);
  return row;
}
