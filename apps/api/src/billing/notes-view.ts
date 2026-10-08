import { schema, type Transaction } from '@paint/db';
import type { NoteKind, NoteReason, NoteSummary, NoteView, SalesReturnView } from '@paint/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { documentView, type TaxDocumentRow } from './invoice-view.js';

const { salesReturnLines, salesReturns, taxDocumentLines, taxDocumentLinks, taxDocuments } = schema;

/** The item at `index` of a list known to be that long (one row per line, one result per input). */
export const nth = <T>(items: readonly T[], index: number): T =>
  (items.slice(index, index + 1) as [T])[0];

/** What earlier returns and notes did to one invoice line. */
export interface LineAdjustment {
  readonly returnedQuantity: number;
  readonly creditedTaxablePaise: number;
  readonly debitedTaxablePaise: number;
}

const NOTHING: LineAdjustment = {
  returnedQuantity: 0,
  creditedTaxablePaise: 0,
  debitedTaxablePaise: 0,
};

const source = alias(taxDocumentLines, 'source');

/**
 * Per line of `invoiceId`: units already returned, and taxable value already
 * credited and debited by issued notes. Lines with no history read as zero.
 */
export async function adjustedSoFar(
  tx: Transaction,
  invoiceId: string,
): Promise<(lineId: string) => LineAdjustment> {
  const returned = await tx
    .select({
      lineId: salesReturnLines.invoiceLineId,
      quantity: sql<number>`sum(${salesReturnLines.quantity})`.mapWith(Number),
    })
    .from(salesReturnLines)
    .innerJoin(salesReturns, eq(salesReturns.id, salesReturnLines.returnId))
    .where(and(eq(salesReturns.invoiceId, invoiceId), eq(salesReturns.status, 'completed')))
    .groupBy(salesReturnLines.invoiceLineId);
  const noted = await tx
    .select({
      lineId: source.id,
      kind: taxDocuments.kind,
      taxablePaise: sql<number>`sum(${taxDocumentLines.taxablePaise})`.mapWith(Number),
    })
    .from(taxDocumentLines)
    .innerJoin(source, eq(source.id, taxDocumentLines.sourceLineId))
    .innerJoin(taxDocuments, eq(taxDocuments.id, taxDocumentLines.documentId))
    .where(and(eq(source.documentId, invoiceId), eq(taxDocuments.status, 'issued')))
    .groupBy(source.id, taxDocuments.kind);
  const byLine = new Map<string, LineAdjustment>();
  const add = (lineId: string, change: Partial<LineAdjustment>) => {
    byLine.set(lineId, { ...(byLine.get(lineId) ?? NOTHING), ...change });
  };
  for (const row of returned) add(row.lineId, { returnedQuantity: row.quantity });
  for (const row of noted) {
    add(
      row.lineId,
      row.kind === 'debit_note'
        ? { debitedTaxablePaise: row.taxablePaise }
        : { creditedTaxablePaise: row.taxablePaise },
    );
  }
  return (lineId) => byLine.get(lineId) ?? NOTHING;
}

const invoice = alias(taxDocuments, 'invoice');

/** Each note's invoice (the link `note_of`). */
async function invoicesOf(tx: Transaction, noteIds: readonly string[]) {
  if (noteIds.length === 0) return new Map<string, { id: string; number: string | null }>();
  const rows = await tx
    .select({
      noteId: taxDocumentLinks.fromDocumentId,
      invoice: { id: invoice.id, number: invoice.number },
    })
    .from(taxDocumentLinks)
    .innerJoin(invoice, eq(invoice.id, taxDocumentLinks.toDocumentId))
    .where(
      and(
        inArray(taxDocumentLinks.fromDocumentId, [...noteIds]),
        eq(taxDocumentLinks.kind, 'note_of'),
      ),
    );
  return new Map(rows.map((row) => [row.noteId, row.invoice]));
}

/** A credit or debit note (kind, reason and link checked by the caller) as the API returns it. */
export async function noteView(tx: Transaction, note: TaxDocumentRow): Promise<NoteView> {
  const document = await documentView(tx, note);
  const sources = await tx
    .select({ id: taxDocumentLines.id, sourceLineId: taxDocumentLines.sourceLineId })
    .from(taxDocumentLines)
    .where(eq(taxDocumentLines.documentId, note.id))
    .orderBy(asc(taxDocumentLines.lineNo));
  // Every note is linked to its invoice when it is issued.
  const [linked] = (await tx
    .select({ id: invoice.id, number: invoice.number, issuedOn: invoice.issuedOn })
    .from(taxDocumentLinks)
    .innerJoin(invoice, eq(invoice.id, taxDocumentLinks.toDocumentId))
    .where(
      and(eq(taxDocumentLinks.fromDocumentId, note.id), eq(taxDocumentLinks.kind, 'note_of')),
    )) as [{ id: string; number: string | null; issuedOn: string | null }];
  const [fromReturn] = await tx
    .select({ id: salesReturns.id })
    .from(salesReturns)
    .where(eq(salesReturns.creditNoteId, note.id));
  return {
    ...document,
    kind: note.kind as NoteKind,
    reason: note.reason as NoteReason,
    itcReversalStatus: note.itcReversalStatus,
    schemeReference: note.schemeReference,
    invoice: linked,
    salesReturnId: fromReturn?.id ?? null,
    // Both in line order, one row per line.
    lines: document.lines.map((line, index) => ({
      ...line,
      sourceLineId: nth(sources, index).sourceLineId,
    })),
  };
}

/** Notes as list rows, with their invoice numbers. */
export async function noteSummaries(
  tx: Transaction,
  notes: readonly TaxDocumentRow[],
): Promise<NoteSummary[]> {
  const invoices = await invoicesOf(
    tx,
    notes.map((note) => note.id),
  );
  return notes.map((note) => {
    const linked = invoices.get(note.id);
    return {
      id: note.id,
      kind: note.kind as NoteKind,
      status: note.status,
      storeId: note.storeId,
      number: note.number,
      issuedOn: note.issuedOn,
      reason: note.reason as NoteReason,
      buyerName: note.buyerName,
      totalPaise: note.totalPaise,
      itcReversalStatus: note.itcReversalStatus,
      // Every note is linked to its invoice, which is numbered.
      invoice: { id: String(linked?.id), number: String(linked?.number) },
    };
  });
}

/** A completed return with its lines and credit note. */
export async function salesReturnView(
  tx: Transaction,
  row: typeof salesReturns.$inferSelect,
): Promise<SalesReturnView> {
  const lines = await tx
    .select({
      id: salesReturnLines.id,
      invoiceLineId: salesReturnLines.invoiceLineId,
      description: taxDocumentLines.description,
      quantity: salesReturnLines.quantity,
      disposition: salesReturnLines.disposition,
      reason: salesReturnLines.reason,
    })
    .from(salesReturnLines)
    .innerJoin(taxDocumentLines, eq(taxDocumentLines.id, salesReturnLines.invoiceLineId))
    .where(eq(salesReturnLines.returnId, row.id))
    .orderBy(asc(taxDocumentLines.lineNo), asc(salesReturnLines.disposition));
  // A completed return always has its number, note and completion time (sales_returns_completed).
  const [note] = (await tx
    .select()
    .from(taxDocuments)
    .where(eq(taxDocuments.id, String(row.creditNoteId)))) as [TaxDocumentRow];
  return {
    id: row.id,
    number: String(row.number),
    invoiceId: row.invoiceId,
    storeId: row.storeId,
    completedAt: String(row.completedAt?.toISOString()),
    note: row.note,
    lines,
    creditNote: await noteView(tx, note),
  };
}
