import { NotFoundException } from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import { canAccessStore, type TaxDocumentLineView, type TaxDocumentView } from '@paint/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';

const { taxDocumentLines, taxDocumentTaxRows, taxDocuments } = schema;

export type TaxDocumentRow = typeof taxDocuments.$inferSelect;

const iso = (date: Date | null) => (date ? date.toISOString() : null);

/** Today's calendar date in India, from the database clock (never the Node clock). */
export async function indiaToday(tx: Transaction): Promise<string> {
  const result = await tx.execute<{ today: string }>(
    sql`select ((now() at time zone 'Asia/Kolkata')::date)::text as today`,
  );
  return String(result.rows[0]?.today);
}

/**
 * The document, locked for the rest of the transaction when `lock` is set. A
 * document at a store the member does not work at is "not found".
 */
export async function loadDocument(
  tx: Transaction,
  auth: AuthContext,
  id: string,
  lock = false,
): Promise<TaxDocumentRow> {
  const query = tx.select().from(taxDocuments).where(eq(taxDocuments.id, id));
  const [document] = lock ? await query.for('update') : await query;
  if (!document || !canAccessStore(auth, document.storeId)) {
    throw new NotFoundException('Invoice not found');
  }
  return document;
}

/** The document as the API returns it, with its lines and tax rows. */
export async function documentView(
  tx: Transaction,
  document: TaxDocumentRow,
): Promise<TaxDocumentView> {
  const { id } = document;
  const lines = await tx
    .select()
    .from(taxDocumentLines)
    .where(eq(taxDocumentLines.documentId, id))
    .orderBy(asc(taxDocumentLines.lineNo));
  const taxRows = await tx
    .select()
    .from(taxDocumentTaxRows)
    .where(eq(taxDocumentTaxRows.documentId, id))
    .orderBy(asc(taxDocumentTaxRows.hsnCode), asc(taxDocumentTaxRows.rateBps));
  return {
    id: document.id,
    kind: document.kind,
    status: document.status,
    storeId: document.storeId,
    number: document.number,
    fy: document.fy,
    issuedOn: document.issuedOn,
    issuedAt: iso(document.issuedAt),
    supplier: {
      gstin: document.supplierGstin,
      stateCode: document.supplierStateCode,
      legalName: document.supplierLegalName,
      tradeName: document.supplierTradeName,
      address: document.supplierAddress,
    },
    buyer: {
      partyId: document.partyId,
      name: document.buyerName,
      gstin: document.buyerGstin,
      address: document.buyerAddress,
      stateCode: document.buyerStateCode,
    },
    shipTo: {
      name: document.shipToName,
      address: document.shipToAddress,
      stateCode: document.shipToStateCode,
    },
    placeOfSupplyCode: document.placeOfSupplyCode,
    supplyType: document.supplyType,
    gstClass: document.gstClass,
    priceMode: document.priceMode,
    reverseCharge: document.reverseCharge,
    billDiscountBps: document.billDiscountBps,
    billDiscountPaise: document.billDiscountPaise,
    taxablePaise: document.taxablePaise,
    cgstPaise: document.cgstPaise,
    sgstPaise: document.sgstPaise,
    igstPaise: document.igstPaise,
    cessPaise: document.cessPaise,
    roundOffPaise: document.roundOffPaise,
    totalPaise: document.totalPaise,
    dueOn: document.dueOn,
    projectId: document.projectId,
    influencerPartyId: document.influencerPartyId,
    note: document.note,
    irn: document.irn,
    ackNo: document.ackNo,
    cancelReason: document.cancelReason,
    cancelledAt: iso(document.cancelledAt),
    lines: lines.map((line): TaxDocumentLineView => ({
      id: line.id,
      lineNo: line.lineNo,
      variantId: line.variantId,
      description: line.description,
      hsnCode: line.hsnCode,
      uqc: line.uqc,
      quantity: line.quantity,
      unitPricePaise: line.unitPricePaise,
      discountBps: line.discountBps,
      discountPaise: line.discountPaise,
      grossPaise: line.grossPaise,
      taxablePaise: line.taxablePaise,
      taxCategoryId: line.taxCategoryId,
      rateBps: line.rateBps,
      cgstPaise: line.cgstPaise,
      sgstPaise: line.sgstPaise,
      igstPaise: line.igstPaise,
      cessPaise: line.cessPaise,
      totalPaise: line.totalPaise,
    })),
    taxRows: taxRows.map((row) => ({
      hsnCode: row.hsnCode,
      rateBps: row.rateBps,
      taxablePaise: row.taxablePaise,
      cgstPaise: row.cgstPaise,
      sgstPaise: row.sgstPaise,
      igstPaise: row.igstPaise,
      cessPaise: row.cessPaise,
    })),
  };
}
