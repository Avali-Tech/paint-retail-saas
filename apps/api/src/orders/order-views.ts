import { NotFoundException } from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import {
  canAccessStore,
  effectiveQuotationStatus,
  openQuantity,
  type CreditCheck,
  type QuotationView,
  type SalesLineView,
  type SalesOrderView,
  type SalesTotalsView,
} from '@paint/shared';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { latestApprovalOf } from '../credit/credit-gate.js';
import { lineTints, withTint } from '../paint/line-tints.js';

const {
  organizationMembers,
  parties,
  productVariants,
  projects,
  quotationLines,
  quotations,
  salesOrderLines,
  salesOrders,
  stockReservations,
  taxDocuments,
  users,
} = schema;

export type QuotationRow = typeof quotations.$inferSelect;
export type SalesOrderRow = typeof salesOrders.$inferSelect;
export type SalesOrderLineRow = typeof salesOrderLines.$inferSelect;

/** What a confirmed postpaid order keeps of its credit check (`sales_orders.credit_check`). */
export interface StoredCreditCheck {
  readonly check: CreditCheck;
  readonly exposureSource: 'manual' | 'ledger';
  readonly position: {
    readonly status: string;
    readonly limitPaise: number;
    readonly exposurePaise: number;
    readonly overdueDays: number;
  };
  /** The site account's check too, when the order is on one (MVP 3 spec §3.3). */
  readonly site?: unknown;
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);

/** The quotation, locked when `lock` is set; one at a store the member cannot see is "not found". */
export async function loadQuotation(
  tx: Transaction,
  auth: AuthContext,
  id: string,
  lock = false,
): Promise<QuotationRow> {
  const query = tx.select().from(quotations).where(eq(quotations.id, id));
  const [row] = lock ? await query.for('update') : await query;
  if (!row || !canAccessStore(auth, row.storeId)) {
    throw new NotFoundException('Quotation not found');
  }
  return row;
}

/** Orders a member sees: placed at, or fulfilled from, a store they work at. */
export function visibleOrders(auth: AuthContext) {
  if (auth.allStores) return undefined;
  const storeIds = [...auth.storeIds];
  return or(
    inArray(salesOrders.storeId, storeIds),
    sql`exists (select 1 from ${salesOrderLines} l where l.order_id = ${sql.raw('"sales_orders"."id"')} and l.fulfil_store_id = any(${`{${storeIds.join(',')}}`}::uuid[]))`,
  );
}

/** The order, locked when `lock` is set; one the member cannot see is "not found". */
export async function loadOrder(
  tx: Transaction,
  auth: AuthContext,
  id: string,
  lock = false,
): Promise<SalesOrderRow> {
  const query = tx
    .select()
    .from(salesOrders)
    .where(and(eq(salesOrders.id, id), visibleOrders(auth)));
  const [row] = lock ? await query.for('update', { of: salesOrders }) : await query;
  if (!row) throw new NotFoundException('Sales order not found');
  return row;
}

/** The order's lines in order, locked with the order when `lock` is set. */
export async function orderLines(
  tx: Transaction,
  orderId: string,
  lock = false,
): Promise<SalesOrderLineRow[]> {
  const query = tx
    .select()
    .from(salesOrderLines)
    .where(eq(salesOrderLines.orderId, orderId))
    .orderBy(asc(salesOrderLines.lineNo));
  return lock ? query.for('update') : query;
}

const totalsOf = (row: QuotationRow | SalesOrderRow): SalesTotalsView => ({
  priceMode: row.priceMode,
  billDiscountBps: row.billDiscountBps,
  billDiscountPaise: row.billDiscountPaise,
  placeOfSupplyCode: row.placeOfSupplyCode,
  supplyType: row.supplyType,
  taxablePaise: row.taxablePaise,
  cgstPaise: row.cgstPaise,
  sgstPaise: row.sgstPaise,
  igstPaise: row.igstPaise,
  cessPaise: row.cessPaise,
  roundOffPaise: row.roundOffPaise,
  totalPaise: row.totalPaise,
});

const lineView = (
  line: typeof quotationLines.$inferSelect | SalesOrderLineRow,
  sku: string,
): SalesLineView => ({
  id: line.id,
  lineNo: line.lineNo,
  variantId: line.variantId,
  sku,
  description: line.description,
  hsnCode: line.hsnCode,
  quantity: line.quantity,
  unitPricePaise: line.unitPricePaise,
  discountBps: line.discountBps,
  discountPaise: line.discountPaise,
  taxablePaise: line.taxablePaise,
  rateBps: line.rateBps,
  cgstPaise: line.cgstPaise,
  sgstPaise: line.sgstPaise,
  igstPaise: line.igstPaise,
  cessPaise: line.cessPaise,
  totalPaise: line.totalPaise,
});

/** Bill-to, influencer and site of a quotation or order (spec §6.4). */
async function peopleOf(tx: Transaction, row: QuotationRow | SalesOrderRow) {
  const [billTo] = (await tx
    .select({
      id: parties.id,
      name: parties.displayName,
      gstin: parties.gstin,
      phone: parties.phone,
    })
    .from(parties)
    .where(eq(parties.id, row.billToPartyId))) as [SalesOrderView['billTo']];
  const [influencer] = row.influencerPartyId
    ? await tx
        .select({ id: parties.id, name: parties.displayName })
        .from(parties)
        .where(eq(parties.id, row.influencerPartyId))
    : [];
  const [project] = row.projectId
    ? await tx
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(eq(projects.id, row.projectId))
    : [];
  return {
    billTo,
    influencer: influencer ?? null,
    project: project ?? null,
    shipTo: { name: row.shipToName, address: row.shipToAddress, stateCode: row.shipToStateCode },
  };
}

/** The quotation version as the API returns it, its status as of `today`. */
export async function quotationView(
  tx: Transaction,
  row: QuotationRow,
  today: string,
): Promise<QuotationView> {
  const lines = await tx
    .select({ line: quotationLines, sku: productVariants.sku })
    .from(quotationLines)
    .innerJoin(productVariants, eq(productVariants.id, quotationLines.variantId))
    .where(eq(quotationLines.quotationId, row.id))
    .orderBy(asc(quotationLines.lineNo));
  const quoteTints = await lineTints(
    tx,
    'quotation_line',
    lines.map(({ line }) => line.id),
  );
  const versions = await tx
    .select({
      id: quotations.id,
      version: quotations.version,
      status: quotations.status,
      validUntil: quotations.validUntil,
      totalPaise: quotations.totalPaise,
      createdAt: quotations.createdAt,
    })
    .from(quotations)
    .where(eq(quotations.number, row.number))
    .orderBy(asc(quotations.version));
  return {
    id: row.id,
    number: row.number,
    version: row.version,
    rootQuotationId: row.rootQuotationId ?? row.id,
    status: effectiveQuotationStatus(row.status, row.validUntil, today),
    storeId: row.storeId,
    ...(await peopleOf(tx, row)),
    ...totalsOf(row),
    validUntil: row.validUntil,
    pricedOn: row.pricedOn,
    note: row.note,
    sentAt: iso(row.sentAt),
    acceptedAt: iso(row.acceptedAt),
    salesOrderId: row.salesOrderId,
    createdByMemberId: row.createdByMemberId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lines: lines.map(({ line, sku }) => withTint(lineView(line, sku), quoteTints)),
    versions: versions.map((version) => ({
      id: version.id,
      version: version.version,
      status: effectiveQuotationStatus(version.status, version.validUntil, today),
      totalPaise: version.totalPaise,
      createdAt: version.createdAt.toISOString(),
    })),
  };
}

/** The order as the API returns it: lines with what is billed and held, reservations, invoices. */
export async function salesOrderView(tx: Transaction, row: SalesOrderRow): Promise<SalesOrderView> {
  const lines = await tx
    .select({
      line: salesOrderLines,
      sku: productVariants.sku,
      reserved:
        sql<number>`coalesce((select sum(r.quantity) from ${stockReservations} r where r.order_line_id = ${sql.raw('"sales_order_lines"."id"')} and r.status = 'open'), 0)`.mapWith(
          Number,
        ),
    })
    .from(salesOrderLines)
    .innerJoin(productVariants, eq(productVariants.id, salesOrderLines.variantId))
    .where(eq(salesOrderLines.orderId, row.id))
    .orderBy(asc(salesOrderLines.lineNo));
  const reservations = await tx
    .select()
    .from(stockReservations)
    .where(
      inArray(
        stockReservations.orderLineId,
        lines.map(({ line }) => line.id),
      ),
    )
    .orderBy(sql`${stockReservations.status} <> 'open'`, asc(stockReservations.createdAt));
  const invoices = await tx
    .select({
      id: taxDocuments.id,
      number: taxDocuments.number,
      status: taxDocuments.status,
      storeId: taxDocuments.storeId,
      issuedOn: taxDocuments.issuedOn,
      totalPaise: taxDocuments.totalPaise,
    })
    .from(taxDocuments)
    .where(eq(taxDocuments.salesOrderId, row.id))
    .orderBy(asc(taxDocuments.createdAt), asc(taxDocuments.id));
  const [quotation] = row.quotationId
    ? await tx
        .select({ number: quotations.number })
        .from(quotations)
        .where(eq(quotations.id, row.quotationId))
    : [];
  const [overrider] = row.creditOverrideByMemberId
    ? await tx
        .select({ name: users.fullName })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(eq(organizationMembers.id, row.creditOverrideByMemberId))
    : [];
  const stored = row.creditCheck as StoredCreditCheck | null;
  const orderTints = await lineTints(
    tx,
    'sales_order_line',
    lines.map(({ line }) => line.id),
  );
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    storeId: row.storeId,
    paymentTerms: row.paymentTerms,
    advanceRequiredPaise: row.advanceRequiredPaise,
    ...(await peopleOf(tx, row)),
    ...totalsOf(row),
    quotationId: row.quotationId,
    quotationNumber: quotation?.number ?? null,
    note: row.note,
    creditCheck: stored?.check ?? null,
    creditOverride:
      row.creditOverrideApproval === null
        ? null
        : {
            approval: row.creditOverrideApproval as 'manager' | 'owner',
            memberId: String(row.creditOverrideByMemberId),
            memberName: String(overrider?.name),
            reason: String(row.creditOverrideReason),
            at: String(iso(row.creditOverriddenAt)),
          },
    creditApproval: await latestApprovalOf(tx, { type: 'sales_order', id: row.id }),
    confirmedAt: iso(row.confirmedAt),
    confirmedByMemberId: row.confirmedByMemberId,
    cancelledAt: iso(row.cancelledAt),
    cancelReason: row.cancelReason,
    invoicedPaise: invoices
      .filter((invoice) => invoice.status === 'issued')
      .reduce((sum, invoice) => sum + invoice.totalPaise, 0),
    createdByMemberId: row.createdByMemberId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lines: lines.map(({ line, sku, reserved }) => ({
      ...withTint(lineView(line, sku), orderTints),
      fulfilStoreId: line.fulfilStoreId,
      quantityInvoiced: line.quantityInvoiced,
      quantityCancelled: line.quantityCancelled,
      quantityReserved: reserved,
      quantityOpen: openQuantity(line),
    })),
    reservations: reservations.map((reservation) => ({
      id: reservation.id,
      orderLineId: reservation.orderLineId,
      storeId: reservation.storeId,
      variantId: reservation.variantId,
      quantity: reservation.quantity,
      status: reservation.status,
      consumedByType: reservation.consumedByType as 'tax_document' | 'dispatch' | null,
      consumedById: reservation.consumedById,
      createdAt: reservation.createdAt.toISOString(),
      closedAt: iso(reservation.closedAt),
    })),
    invoices,
  };
}

/** Newest first, for the lists. */
export const newestFirst = (table: typeof quotations | typeof salesOrders) => [
  desc(table.createdAt),
  desc(table.id),
];
