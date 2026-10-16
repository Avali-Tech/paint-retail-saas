import { randomUUID } from 'node:crypto';
import {
  postStockMovementsInBulk,
  schema,
  type BulkStockMovement,
  type TenantTransaction,
} from '@paint/db';
import { defaultSeries, financialYear, formatDocumentNumber } from '@paint/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { PgInsertValue, PgTable } from 'drizzle-orm/pg-core';
import { dayOpensAt, indiaDate } from '../demo/history-clock.js';
import type { Random } from '../demo/random.js';

/**
 * A large shop's brand money, for the scale tests of brand schemes, the price-hike
 * planner and brand profitability (MVP 3 round 6b, docs/performance.md): many brands
 * with their packs, a year of GRNs from each brand's distributor, and sale invoices
 * (with their lines, stock movements and a few credit notes) drawing that stock
 * down. Written in bulk in the business's tenant transaction, so row-level security,
 * the audit log and the stock and tax-document rules apply: invoices are inserted as
 * drafts with their lines, then issued in one statement, as the API leaves them.
 *
 * The sale invoices are not paid (their credit cost reads every one as owed): a worst
 * case for brand profitability's bills query. The caller adds paid receivables books
 * (bulk-receivables.ts) for allocations.
 */

const {
  brands,
  documentSeries,
  goodsReceiptLines,
  goodsReceipts,
  parties,
  partyRoles,
  productVariants,
  products,
  stores: storesTable,
  supplierProducts,
  taxDocumentLines,
  taxDocuments,
} = schema;

export interface BrandMoneyScale {
  readonly brands: number;
  readonly productsPerBrand: number;
  readonly grns: number;
  readonly linesPerGrn: number;
  readonly invoices: number;
  readonly linesPerInvoice: number;
  /** How many days back the books go. */
  readonly days: number;
  /** One sale invoice in this many gets a credit note for one unit of its first line. */
  readonly creditNoteEvery: number;
}

export interface BrandMoneyInput {
  readonly organizationId: string;
  readonly memberId: string;
  readonly storeIds: readonly string[];
  readonly customerIds: readonly string[];
  readonly taxCategoryId: string;
  readonly now: Date;
}

export interface BrandMoneyBooks {
  /** Brand ids, the first one with the most packs bought. */
  readonly brandIds: readonly string[];
  readonly products: number;
  readonly variants: number;
  readonly grns: number;
  readonly grnLines: number;
  readonly invoices: number;
  readonly invoiceLines: number;
  readonly creditNotes: number;
  readonly stockMovements: number;
}

interface Variant {
  readonly id: string;
  readonly brandId: string;
  readonly costPaise: number;
  readonly pricePaise: number;
}

const PACKS = [
  { size: 1, unit: 'l' },
  { size: 4, unit: 'l' },
  { size: 10, unit: 'l' },
  { size: 20, unit: 'l' },
] as const;
const CHUNK = 2_000;
const HOUR = 3_600_000;

async function insertAll<T extends PgTable>(
  tx: TenantTransaction,
  table: T,
  rows: readonly PgInsertValue<T>[],
): Promise<void> {
  for (let start = 0; start < rows.length; start += CHUNK) {
    await tx.insert(table).values(rows.slice(start, start + CHUNK));
  }
}

/** A line's tax-inclusive split at 18 %: taxable, then equal CGST and SGST (intra-state). */
function split(totalPaise: number) {
  const half = Math.floor((totalPaise - Math.round(totalPaise / 1.18)) / 2);
  return { taxable: totalPaise - 2 * half, cgst: half, sgst: half };
}

export async function writeBrandMoneyBooks(
  tx: TenantTransaction,
  random: Random,
  input: BrandMoneyInput,
  scale: BrandMoneyScale,
): Promise<BrandMoneyBooks> {
  const { organizationId, memberId, now } = input;
  const at = (daysAgo: number) =>
    new Date(dayOpensAt(daysAgo, now).getTime() + random.next() * 9 * HOUR);

  // Catalogue: each brand's products in four pack sizes, two per product.
  const brandIds: string[] = Array.from({ length: scale.brands }, () => randomUUID());
  await insertAll(
    tx,
    brands,
    brandIds.map((id, index) => ({
      id,
      organizationId,
      name: `Scale Brand ${String(index + 1).padStart(2, '0')}`,
    })),
  );
  const productRows: PgInsertValue<typeof products>[] = [];
  const variantRows: PgInsertValue<typeof productVariants>[] = [];
  const variants: Variant[] = [];
  brandIds.forEach((brandId, brandIndex) => {
    for (let product = 0; product < scale.productsPerBrand; product += 1) {
      const productId = randomUUID();
      productRows.push({
        id: productId,
        organizationId,
        brandId,
        name: `Scale Product ${String(brandIndex + 1)}-${String(product + 1)}`,
        type: product % 2 === 0 ? 'exterior_paint' : 'interior_paint',
        hsnCode: '3209',
        taxCategoryId: input.taxCategoryId,
        gstRateBps: 1800,
      });
      const perLitre = random.int(150, 450) * 100;
      for (const pack of random.sample([...PACKS], 2)) {
        const id = randomUUID();
        const costPaise = pack.size * perLitre;
        const pricePaise = Math.round((costPaise * 1.25 * 1.18) / 100) * 100;
        variantRows.push({
          id,
          organizationId,
          productId,
          sku: `S${String(brandIndex + 1)}-${String(product + 1)}-${String(pack.size)}L`,
          packSize: pack.size,
          unit: pack.unit,
          sellingPricePaise: pricePaise,
        });
        variants.push({ id, brandId, costPaise, pricePaise });
      }
    }
  });
  await insertAll(tx, products, productRows);
  await insertAll(tx, productVariants, variantRows);

  // Each brand's distributor.
  const supplierOf = new Map<string, string>(brandIds.map((brandId) => [brandId, randomUUID()]));
  await insertAll(
    tx,
    parties,
    [...supplierOf.values()].map((id, index) => ({
      id,
      organizationId,
      kind: 'organization' as const,
      displayName: `Scale Distributor ${String(index + 1)}`,
    })),
  );
  await insertAll(
    tx,
    partyRoles,
    [...supplierOf.values()].map((partyId) => ({
      organizationId,
      partyId,
      role: 'supplier' as const,
    })),
  );
  const byBrand = new Map<string, Variant[]>();
  for (const variant of variants) {
    byBrand.set(variant.brandId, [...(byBrand.get(variant.brandId) ?? []), variant]);
  }

  // GRNs: brands bought unevenly (the first brand most), over the whole period.
  const events: { time: number; movement: BulkStockMovement }[] = [];
  const grnRows: PgInsertValue<typeof goodsReceipts>[] = [];
  const grnLineRows: PgInsertValue<typeof goodsReceiptLines>[] = [];
  const lastCost = new Map<string, { cost: number; at: Date }>();
  const brandWeights = brandIds.map((_, index) => 1 / (index + 1));
  const weightTotal = brandWeights.reduce((sum, weight) => sum + weight, 0);
  const pickBrand = () => {
    let roll = random.next() * weightTotal;
    for (const [index, weight] of brandWeights.entries()) {
      roll -= weight;
      if (roll <= 0) return String(brandIds[index]);
    }
    return String(brandIds.at(-1));
  };
  for (let grn = 0; grn < scale.grns; grn += 1) {
    const id = randomUUID();
    const brandId = pickBrand();
    const storeId = random.pick([...input.storeIds]);
    const daysAgo = random.int(1, scale.days);
    const receivedAt = at(daysAgo);
    const number = formatDocumentNumber('GRN', grn + 1);
    grnRows.push({
      id,
      organizationId,
      number,
      storeId,
      supplierPartyId: String(supplierOf.get(brandId)),
      supplierInvoiceNumber: `SI/${String(grn + 1)}`,
      supplierInvoiceDate: indiaDate(daysAgo + random.int(0, 3), now),
      receivedByMemberId: memberId,
      receivedAt,
    });
    const own = byBrand.get(brandId) ?? [];
    for (const variant of random.sample(own, Math.min(own.length, scale.linesPerGrn))) {
      const quantity = random.int(10, 60);
      const free = random.chance(0.1) ? Math.floor(quantity / 10) : 0;
      const unitCostPaise = Math.round(variant.costPaise * (0.95 + random.next() * 0.1));
      grnLineRows.push({
        organizationId,
        goodsReceiptId: id,
        variantId: variant.id,
        quantity,
        freeQuantity: free,
        unitCostPaise,
      });
      const base = {
        organizationId,
        storeId,
        variantId: variant.id,
        movementType: 'purchase_receipt' as const,
        referenceType: 'goods_receipt',
        referenceId: id,
        createdByMemberId: memberId,
        createdAt: receivedAt,
      };
      events.push({
        time: receivedAt.getTime(),
        movement: { ...base, quantity, unitCostPaise, note: number },
      });
      if (free > 0) {
        events.push({
          time: receivedAt.getTime(),
          movement: { ...base, quantity: free, unitCostPaise: 0, note: `${number} free` },
        });
      }
      const last = lastCost.get(variant.id);
      if (last === undefined || last.at < receivedAt) {
        lastCost.set(variant.id, { cost: unitCostPaise, at: receivedAt });
      }
    }
  }

  // Sales: invoices of a few packs each, never taking stock below zero.
  const sales = Array.from({ length: scale.invoices }, (_, index) => {
    const daysAgo = random.int(1, scale.days - 1);
    return { index, issuedAt: at(daysAgo), daysAgo };
  });
  const timeline = [
    ...events.map((event) => ({ time: event.time, event, sale: null })),
    ...sales.map((sale) => ({ time: sale.issuedAt.getTime(), event: null, sale })),
  ].sort((a, b) => a.time - b.time);
  const onHand = new Map<string, number>();
  const movements: BulkStockMovement[] = [];
  const invoiceRows: (PgInsertValue<typeof taxDocuments> & { id: string })[] = [];
  const lineRows: (PgInsertValue<typeof taxDocumentLines> & { id: string })[] = [];
  const issue: { id: string; storeId: string; kind: 'invoice' | 'credit_note'; issuedAt: Date }[] =
    [];
  let creditNotes = 0;
  for (const { event, sale } of timeline) {
    if (event !== null) {
      const key = `${event.movement.storeId}:${event.movement.variantId}`;
      onHand.set(key, (onHand.get(key) ?? 0) + event.movement.quantity);
      movements.push(event.movement);
      continue;
    }
    const storeId = random.pick([...input.storeIds]);
    // A few packs tried at random (one shuffle of the catalogue per bill would be slow).
    const stocked = [
      ...new Set(Array.from({ length: scale.linesPerInvoice * 4 }, () => random.pick(variants))),
    ];
    const id = randomUUID();
    const lines: { variant: Variant; quantity: number; id: string }[] = [];
    for (const variant of stocked) {
      if (lines.length === scale.linesPerInvoice) break;
      const key = `${storeId}:${variant.id}`;
      const quantity = Math.min(random.int(1, 6), onHand.get(key) ?? 0);
      if (quantity <= 0) continue;
      onHand.set(key, (onHand.get(key) ?? 0) - quantity);
      lines.push({ variant, quantity, id: randomUUID() });
      movements.push({
        organizationId,
        storeId,
        variantId: variant.id,
        movementType: 'sale',
        quantity: -quantity,
        referenceType: 'tax_document',
        referenceId: id,
        createdByMemberId: memberId,
        createdAt: sale.issuedAt,
      });
    }
    if (lines.length === 0) continue;
    const totals = { taxable: 0, cgst: 0, sgst: 0, total: 0 };
    lines.forEach((line, index) => {
      const total = line.quantity * line.variant.pricePaise;
      const { taxable, cgst, sgst } = split(total);
      totals.taxable += taxable;
      totals.cgst += cgst;
      totals.sgst += sgst;
      totals.total += total;
      lineRows.push({
        id: line.id,
        organizationId,
        documentId: id,
        lineNo: index + 1,
        variantId: line.variant.id,
        hsnCode: '3209',
        quantity: line.quantity,
        unitPricePaise: line.variant.pricePaise,
        grossPaise: total,
        taxablePaise: taxable,
        cgstPaise: cgst,
        sgstPaise: sgst,
        totalPaise: total,
      });
    });
    const partyId = random.pick([...input.customerIds]);
    invoiceRows.push({
      id,
      organizationId,
      kind: 'invoice',
      storeId,
      partyId,
      buyerName: 'Scale Customer',
      supplierStateCode: '36',
      buyerStateCode: '36',
      taxablePaise: totals.taxable,
      cgstPaise: totals.cgst,
      sgstPaise: totals.sgst,
      totalPaise: totals.total,
      dueOn: indiaDate(Math.max(sale.daysAgo - 30, 0), now),
      createdByMemberId: memberId,
      createdAt: sale.issuedAt,
      updatedAt: sale.issuedAt,
    });
    issue.push({ id, storeId, kind: 'invoice', issuedAt: sale.issuedAt });

    // Now and then one unit of the first line comes back, a few days later.
    const [first] = lines;
    if (sale.index % scale.creditNoteEvery !== 0 || first === undefined || sale.daysAgo < 5) {
      continue;
    }
    creditNotes += 1;
    const noteId = randomUUID();
    const noteAt = new Date(sale.issuedAt.getTime() + 3 * 24 * HOUR);
    const { taxable, cgst, sgst } = split(first.variant.pricePaise);
    invoiceRows.push({
      id: noteId,
      organizationId,
      kind: 'credit_note',
      storeId,
      partyId,
      buyerName: 'Scale Customer',
      supplierStateCode: '36',
      buyerStateCode: '36',
      taxablePaise: taxable,
      cgstPaise: cgst,
      sgstPaise: sgst,
      totalPaise: first.variant.pricePaise,
      reason: 'Goods returned',
      createdByMemberId: memberId,
      createdAt: noteAt,
      updatedAt: noteAt,
    });
    lineRows.push({
      id: randomUUID(),
      organizationId,
      documentId: noteId,
      lineNo: 1,
      variantId: first.variant.id,
      hsnCode: '3209',
      quantity: 1,
      unitPricePaise: first.variant.pricePaise,
      grossPaise: first.variant.pricePaise,
      taxablePaise: taxable,
      cgstPaise: cgst,
      sgstPaise: sgst,
      totalPaise: first.variant.pricePaise,
      sourceLineId: first.id,
    });
    issue.push({ id: noteId, storeId, kind: 'credit_note', issuedAt: noteAt });
    movements.push({
      organizationId,
      storeId,
      variantId: first.variant.id,
      movementType: 'sale_return',
      quantity: 1,
      referenceType: 'tax_document',
      referenceId: noteId,
      createdByMemberId: memberId,
      createdAt: noteAt,
    });
  }

  await insertAll(tx, goodsReceipts, grnRows);
  await insertAll(tx, goodsReceiptLines, grnLineRows);
  await insertAll(
    tx,
    supplierProducts,
    variants.flatMap((variant) => {
      const last = lastCost.get(variant.id);
      return last === undefined
        ? []
        : [
            {
              organizationId,
              supplierPartyId: String(supplierOf.get(variant.brandId)),
              variantId: variant.id,
              lastCostPaise: last.cost,
              lastReceivedAt: last.at,
            },
          ];
    }),
  );
  // In time order per store and pack (sale returns land after their sale).
  movements.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  await postStockMovementsInBulk(tx, movements);

  // Drafts with their lines, then issued in one statement per chunk.
  await insertAll(tx, taxDocuments, invoiceRows);
  await insertAll(tx, taxDocumentLines, lineRows);
  const storeRows = await tx
    .select({ id: storesTable.id, code: storesTable.code, gstin: storesTable.gstin })
    .from(storesTable);
  const seriesOf = new Map<string, string>();
  const series = async (storeId: string, kind: 'invoice' | 'credit_note') => {
    const key = `${storeId}:${kind}`;
    const known = seriesOf.get(key);
    if (known !== undefined) return known;
    const code = String(storeRows.find((row) => row.id === storeId)?.code);
    const [existing] = await tx
      .select({ id: documentSeries.id })
      .from(documentSeries)
      .where(
        and(
          eq(documentSeries.storeId, storeId),
          eq(documentSeries.kind, kind),
          eq(documentSeries.isActive, true),
        ),
      );
    const id =
      existing?.id ??
      String(
        (
          await tx
            .insert(documentSeries)
            .values({
              organizationId,
              storeId,
              kind,
              ...(defaultSeries(code, kind) ?? { prefix: code, digits: 6 }),
            })
            .returning({ id: documentSeries.id })
        )[0]?.id,
      );
    seriesOf.set(key, id);
    return id;
  };
  const issued: Record<string, string>[] = [];
  let serial = 0;
  for (const document of issue) {
    serial += 1;
    const issuedOn = new Date(document.issuedAt.getTime() + 5.5 * HOUR).toISOString().slice(0, 10);
    issued.push({
      id: document.id,
      number: `${document.kind === 'invoice' ? 'SC' : 'SR'}${String(serial).padStart(6, '0')}`,
      fy: financialYear(issuedOn),
      issued_on: issuedOn,
      issued_at: document.issuedAt.toISOString(),
      series_id: await series(document.storeId, document.kind),
      supplier_gstin: String(storeRows.find((row) => row.id === document.storeId)?.gstin),
    });
  }
  for (let start = 0; start < issued.length; start += CHUNK) {
    await tx.execute(sql`
      update ${taxDocuments} d set status = 'issued', number = x.number, fy = x.fy,
        issued_on = x.issued_on, issued_at = x.issued_at, series_id = x.series_id,
        supplier_gstin = x.supplier_gstin, issued_by_member_id = ${memberId},
        supply_type = 'intra_state', place_of_supply_code = '36', gst_class = 'b2cs'
      from jsonb_to_recordset(${JSON.stringify(issued.slice(start, start + CHUNK))}::jsonb)
        as x(id uuid, number text, fy text, issued_on date, issued_at timestamptz,
          series_id uuid, supplier_gstin text)
      where d.id = x.id
    `);
  }

  return {
    brandIds,
    products: productRows.length,
    variants: variants.length,
    grns: grnRows.length,
    grnLines: grnLineRows.length,
    invoices: invoiceRows.length - creditNotes,
    invoiceLines: lineRows.length,
    creditNotes,
    stockMovements: movements.length,
  };
}
