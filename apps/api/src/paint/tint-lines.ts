import { NotFoundException } from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import type { TintLineKind } from '@paint/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';

const {
  productVariants,
  products,
  quotationLines,
  quotations,
  salesOrderLines,
  salesOrders,
  taxDocumentLines,
  taxDocuments,
  tintRecords,
} = schema;

/** A line a tint record can be on, with what the record copies from it and its document. */
export interface TintLine {
  readonly kind: TintLineKind;
  readonly lineId: string;
  readonly variantId: string;
  readonly quantity: number;
  /** "quotation", "sales order", "invoice": for messages. */
  readonly documentName: string;
  readonly documentStatus: string;
  /** Where it is tinted: the document's store (an order line's fulfil store). */
  readonly storeId: string;
  /** Members of any of these stores may tint it (an order: its store or the line's). */
  readonly storeIds: readonly string[];
  readonly partyId: string | null;
  readonly projectId: string | null;
  /** The base product's brand and whether it is tintable. */
  readonly brandId: string;
  readonly isTintable: boolean;
}

const product = {
  variantId: productVariants.id,
  brandId: products.brandId,
  isTintable: products.isTintable,
};

/**
 * The line of `kind`, with its document locked (so its status holds until the
 * transaction ends); "not found" when there is none, or it is a note's line.
 */
export async function loadTintLine(
  tx: Transaction,
  kind: TintLineKind,
  lineId: string,
): Promise<TintLine> {
  let line: TintLine | undefined;
  if (kind === 'quotation_line') {
    const [row] = await tx
      .select({
        ...product,
        quantity: quotationLines.quantity,
        status: quotations.status,
        storeId: quotations.storeId,
        partyId: quotations.billToPartyId,
        projectId: quotations.projectId,
      })
      .from(quotationLines)
      .innerJoin(quotations, eq(quotations.id, quotationLines.quotationId))
      .innerJoin(productVariants, eq(productVariants.id, quotationLines.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(eq(quotationLines.id, lineId))
      .for('update', { of: quotations });
    line = row && {
      ...row,
      kind,
      lineId,
      documentName: 'quotation',
      documentStatus: row.status,
      storeIds: [row.storeId],
    };
  } else if (kind === 'sales_order_line') {
    const [row] = await tx
      .select({
        ...product,
        quantity: salesOrderLines.quantity,
        status: salesOrders.status,
        orderStoreId: salesOrders.storeId,
        storeId: salesOrderLines.fulfilStoreId,
        partyId: salesOrders.billToPartyId,
        projectId: salesOrders.projectId,
      })
      .from(salesOrderLines)
      .innerJoin(salesOrders, eq(salesOrders.id, salesOrderLines.orderId))
      .innerJoin(productVariants, eq(productVariants.id, salesOrderLines.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(eq(salesOrderLines.id, lineId))
      .for('update', { of: salesOrders });
    line = row && {
      ...row,
      kind,
      lineId,
      documentName: 'sales order',
      documentStatus: row.status,
      storeIds: [row.orderStoreId, row.storeId],
    };
  } else {
    const [row] = await tx
      .select({
        ...product,
        quantity: taxDocumentLines.quantity,
        status: taxDocuments.status,
        storeId: taxDocuments.storeId,
        partyId: taxDocuments.partyId,
        projectId: taxDocuments.projectId,
      })
      .from(taxDocumentLines)
      .innerJoin(taxDocuments, eq(taxDocuments.id, taxDocumentLines.documentId))
      .innerJoin(productVariants, eq(productVariants.id, taxDocumentLines.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          eq(taxDocumentLines.id, lineId),
          inArray(taxDocuments.kind, ['invoice', 'bill_of_supply']),
        ),
      )
      .for('update', { of: taxDocuments });
    line = row && {
      ...row,
      kind,
      lineId,
      documentName: 'invoice',
      documentStatus: row.status,
      storeIds: [row.storeId],
    };
  }
  if (!line) throw new NotFoundException('Line not found');
  return line;
}

/** The tint-record column naming a line of `kind`. */
export const tintLineColumn = (kind: TintLineKind) =>
  kind === 'quotation_line'
    ? tintRecords.quotationLineId
    : kind === 'sales_order_line'
      ? tintRecords.salesOrderLineId
      : tintRecords.invoiceLineId;

/** One line copied to another (a revision, a conversion, a bill from an order). */
export interface TintCarry {
  readonly fromLineId: string;
  readonly toLineId: string;
  /** The new line's quantity: at most this many packs stay tinted. */
  readonly quantity: number;
  /** Where the new line is tinted. */
  readonly storeId: string;
}

/** The new document's bill-to and site, which its tint records copy. */
export interface TintTarget {
  readonly partyId: string | null;
  readonly projectId: string | null;
}

/** Pairs copied lines by line number (copies keep their lines' numbers). */
export function carriesByLineNo(
  from: readonly { readonly id: string; readonly lineNo: number }[],
  to: readonly {
    readonly id: string;
    readonly lineNo: number;
    readonly quantity: number;
    readonly storeId: string;
  }[],
): TintCarry[] {
  return to.flatMap((line) => {
    const source = from.find((candidate) => candidate.lineNo === line.lineNo);
    return source
      ? [
          {
            fromLineId: source.id,
            toLineId: line.id,
            quantity: line.quantity,
            storeId: line.storeId,
          },
        ]
      : [];
  });
}

/**
 * Carries the tint record of each `from` line, if any, to its new line (spec
 * §6.3: a quote's shade goes to its order and invoice), as the member doing
 * the copy. Runs in the copying transaction; the new lines' documents are
 * drafts, which the tint_records_draft_only trigger requires.
 */
export async function carryTints(
  tx: Transaction,
  memberId: string,
  from: TintLineKind,
  to: TintLineKind,
  target: TintTarget,
  carries: readonly TintCarry[],
): Promise<void> {
  const column = tintLineColumn(from);
  const tinted = await tx
    .select({ lineId: column })
    .from(tintRecords)
    .where(
      inArray(
        column,
        carries.map((carry) => carry.fromLineId),
      ),
    );
  const source = sql.identifier(column.name);
  const destination = sql.identifier(tintLineColumn(to).name);
  for (const carry of carries.filter((item) =>
    tinted.some((row) => row.lineId === item.fromLineId),
  )) {
    await tx.execute(sql`
      insert into tint_records (organization_id, store_id, party_id, project_id, ${destination},
        brand_id, shade_code, shade_name, base_variant_id, pack_quantity, colorant_cost_paise,
        tint_charge_paise, machine, formula, note, created_by_member_id)
      select t.organization_id, ${carry.storeId}, ${target.partyId}, ${target.projectId},
        ${carry.toLineId}, t.brand_id, t.shade_code, t.shade_name, t.base_variant_id,
        least(t.pack_quantity, ${carry.quantity}::numeric), t.colorant_cost_paise,
        t.tint_charge_paise, t.machine, t.formula, t.note, ${memberId}
      from tint_records t where t.${source} = ${carry.fromLineId}`);
  }
}
