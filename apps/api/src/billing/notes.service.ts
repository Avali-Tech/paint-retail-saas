import 'reflect-metadata';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection } from '@paint/db';
import {
  canAccessStore,
  creditNoteWindow,
  type InvoiceAdjustments,
  type NotePage,
  type NoteView,
  type SalesReturnView,
} from '@paint/shared';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import {
  afterKey,
  cappedTotal,
  cursorTime,
  keysetSlice,
  NEWEST_FIRST,
  pageOffset,
} from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';
import { containsPattern } from '../parties/party-access.js';
import { indiaToday, loadDocument } from './invoice-view.js';
import type { ListNotesQuery } from './notes.schemas.js';
import { adjustedSoFar, noteSummaries, noteView, salesReturnView } from './notes-view.js';

const { salesReturns, taxDocumentLines, taxDocumentLinks, taxDocuments } = schema;

const NOTE_KINDS = ['credit_note', 'debit_note'] as const;

/** Reading credit and debit notes, sales returns, and what an invoice has had returned. */
@Injectable()
export class NotesService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  getNote(auth: AuthContext, id: string): Promise<NoteView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const note = await loadDocument(tx, auth, id);
      if (note.kind !== 'credit_note' && note.kind !== 'debit_note') {
        throw new NotFoundException('Note not found');
      }
      return noteView(tx, note);
    });
  }

  listNotes(auth: AuthContext, query: ListNotesQuery): Promise<NotePage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        inArray(taxDocuments.kind, query.kind ? [query.kind] : [...NOTE_KINDS]),
        auth.allStores ? undefined : inArray(taxDocuments.storeId, [...auth.storeIds]),
        query.storeId ? eq(taxDocuments.storeId, query.storeId) : undefined,
        query.partyId ? eq(taxDocuments.partyId, query.partyId) : undefined,
        query.invoiceId
          ? sql`exists (select 1 from ${taxDocumentLinks} l where l.from_document_id = ${taxDocuments.id} and l.to_document_id = ${query.invoiceId} and l.kind = 'note_of')`
          : undefined,
        query.from ? sql`${taxDocuments.issuedOn} >= ${query.from}::date` : undefined,
        query.to ? sql`${taxDocuments.issuedOn} <= ${query.to}::date` : undefined,
        query.q
          ? or(
              ilike(taxDocuments.number, containsPattern(query.q)),
              ilike(taxDocuments.buyerName, containsPattern(query.q)),
            )
          : undefined,
      );
      const rows = await tx
        .select({ note: taxDocuments, cursorAt: cursorTime(taxDocuments.createdAt) })
        .from(taxDocuments)
        .where(
          and(
            where,
            afterKey(NEWEST_FIRST, [taxDocuments.createdAt, taxDocuments.id], query.cursor),
          ),
        )
        .orderBy(desc(taxDocuments.createdAt), desc(taxDocuments.id))
        .limit(query.limit + 1)
        .offset(pageOffset(query));
      const page = keysetSlice(rows, query.limit, (row) => [row.cursorAt, row.note.id]);
      return {
        items: await noteSummaries(
          tx,
          page.rows.map((row) => row.note),
        ),
        nextCursor: page.nextCursor,
        ...(await cappedTotal(
          tx,
          tx.select({ id: taxDocuments.id }).from(taxDocuments).where(where).$dynamic(),
        )),
      };
    });
  }

  getReturn(auth: AuthContext, id: string): Promise<SalesReturnView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [row] = await tx.select().from(salesReturns).where(eq(salesReturns.id, id));
      if (!row || !canAccessStore(auth, row.storeId)) {
        throw new NotFoundException('Return not found');
      }
      return salesReturnView(tx, row);
    });
  }

  /** What has come back and been adjusted on each line, the notes, and the s.34(2) window. */
  adjustments(auth: AuthContext, invoiceId: string): Promise<InvoiceAdjustments> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const invoice = await loadDocument(tx, auth, invoiceId);
      const lines = await tx
        .select({
          id: taxDocumentLines.id,
          lineNo: taxDocumentLines.lineNo,
          quantity: taxDocumentLines.quantity,
        })
        .from(taxDocumentLines)
        .where(eq(taxDocumentLines.documentId, invoiceId))
        .orderBy(asc(taxDocumentLines.lineNo));
      const sofar = await adjustedSoFar(tx, invoiceId);
      const notes = await tx
        .select()
        .from(taxDocuments)
        .where(
          sql`${taxDocuments.id} in (select l.from_document_id from ${taxDocumentLinks} l where l.to_document_id = ${invoiceId} and l.kind = 'note_of')`,
        )
        .orderBy(asc(taxDocuments.createdAt), asc(taxDocuments.id));
      const takesNotes =
        invoice.status === 'issued' &&
        (invoice.kind === 'invoice' || invoice.kind === 'bill_of_supply');
      return {
        invoiceId,
        creditNoteWindow: takesNotes
          ? creditNoteWindow(String(invoice.issuedOn), await indiaToday(tx))
          : null,
        lines: lines.map((line) => ({
          invoiceLineId: line.id,
          lineNo: line.lineNo,
          soldQuantity: line.quantity,
          ...sofar(line.id),
        })),
        notes: await noteSummaries(tx, notes),
      };
    });
  }
}
