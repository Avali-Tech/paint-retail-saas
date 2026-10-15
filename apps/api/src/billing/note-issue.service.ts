import 'reflect-metadata';
import {
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  adjustPartyAdvance,
  nextDocumentNumber,
  postPartyLedger,
  postStockMovements,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import {
  computeAdjustment,
  computeReturn,
  creditNoteWindow,
  formatDocumentNumber,
  noteSourceOf,
  type CreditNote,
  type NoteKind,
  type NoteReason,
  type NoteView,
  type SalesReturnView,
} from '@paint/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { lockParty } from '../payments/posting.js';
import { fieldError } from '../tax/tax-lookups.js';
import { idempotent } from './idempotency.js';
import { indiaToday, loadDocument, type TaxDocumentRow } from './invoice-view.js';
import { dispatchedByLine } from '../orders/dispatched.js';
import { reverseLoyaltyForNote } from './loyalty-reversal.js';
import { reverseInfluencerPointsForNote } from '../loyalty/painter-points.js';
import { takeDocumentNumber } from './series.js';
import type { CreditNoteInput, DebitNoteInput, SalesReturnInput } from './notes.schemas.js';
import { adjustedSoFar, noteView, nth, salesReturnView } from './notes-view.js';

const {
  allocations,
  salesReturnLines,
  salesReturns,
  stores,
  taxDocumentLines,
  taxDocumentLinks,
  taxDocumentTaxRows,
  taxDocuments,
} = schema;

type InvoiceLineRow = typeof taxDocumentLines.$inferSelect;

/** Thousandths, so quantities (at most 3 decimals) add up exactly. */
const milli = (quantity: number) => Math.round(quantity * 1000);

/** A refusal naming the fields at fault, shaped like the validation pipe's answers. */
const unprocessable = (message: string, issues: { path: string; message: string }[]) =>
  new UnprocessableEntityException({ statusCode: 422, message, issues });

/** What a note is about to say: its kind, reason and the engine's figures per source line. */
interface PendingNote {
  readonly kind: NoteKind;
  readonly reason: NoteReason;
  readonly invoice: TaxDocumentRow;
  readonly sourceLines: readonly InvoiceLineRow[];
  readonly computed: CreditNote;
  /** Units per computed line: returned units, or the units the value relates to. */
  readonly quantities: readonly number[];
  readonly stockPosting: 'on_issue' | 'none';
  readonly note: string | null;
  /** s.15(3)(b): the pre-agreed scheme of a discount credit note. */
  readonly schemeReference: string | null;
  readonly today: string;
}

/**
 * Sales returns, credit notes and debit notes (spec §2.9, §4.5): each in one
 * transaction that numbers the note in the store's series for its kind, links
 * it to the invoice, snapshots its lines and tax at the invoice's rate, moves
 * the stock back and writes the party ledger, or does none of it. The invoice
 * is locked first, so two returns of one invoice cannot both take its last units.
 */
@Injectable()
export class NoteIssueService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  returnGoods(
    auth: AuthContext,
    input: SalesReturnInput,
    idempotencyKey?: string,
  ): Promise<SalesReturnView> {
    const request = { method: 'POST', path: '/sales-returns', body: input };
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, () => this.returnIn(tx, auth, input)),
    );
  }

  creditNote(
    auth: AuthContext,
    input: CreditNoteInput,
    idempotencyKey?: string,
  ): Promise<NoteView> {
    const request = { method: 'POST', path: '/credit-notes', body: input };
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, () =>
        this.valueNoteIn(tx, auth, 'credit_note', input.reason, input, input.schemeReference),
      ),
    );
  }

  debitNote(auth: AuthContext, input: DebitNoteInput, idempotencyKey?: string): Promise<NoteView> {
    const request = { method: 'POST', path: '/debit-notes', body: input };
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, () =>
        this.valueNoteIn(tx, auth, 'debit_note', 'undercharge', input, undefined),
      ),
    );
  }

  private async returnIn(
    tx: Transaction,
    auth: AuthContext,
    input: SalesReturnInput,
  ): Promise<SalesReturnView> {
    const organizationId = auth.organization.id;
    const {
      invoice,
      lines: sourceLines,
      today,
    } = await this.openInvoice(tx, auth, input.invoiceId);
    this.assertCreditWindow(invoice, today);
    const lineOf = this.lineFinder(sourceLines);

    // Units coming back per invoice line now (both dispositions), in invoice line order.
    const wanted = new Map<string, number>();
    input.lines.forEach((line, index) => {
      lineOf(line.invoiceLineId, `lines.${String(index)}.invoiceLineId`);
      wanted.set(line.invoiceLineId, (wanted.get(line.invoiceLineId) ?? 0) + milli(line.quantity));
    });
    const sofar = await adjustedSoFar(tx, invoice.id);
    // Goods billed now and handed over later come back only once they have left (spec §4.2).
    const dispatched =
      invoice.stockPosting === 'on_dispatch' ? await dispatchedByLine(tx, invoice.id) : null;
    const returnable = (line: InvoiceLineRow) =>
      dispatched === null ? line.quantity : dispatched(line.id);
    const returning = sourceLines.filter((line) => wanted.has(line.id));
    const over = input.lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => {
        const source = lineOf(line.invoiceLineId, '');
        const before = milli(sofar(source.id).returnedQuantity);
        return before + Number(wanted.get(source.id)) > milli(returnable(source));
      });
    if (over.length > 0) {
      throw unprocessable(
        'More would come back than was sold',
        over.map(({ line, index }) => {
          const source = lineOf(line.invoiceLineId, '');
          const left = returnable(source) - sofar(source.id).returnedQuantity;
          return {
            path: `lines.${String(index)}.quantity`,
            message: `At most ${String(Math.max(0, Math.round(left * 1000) / 1000))} of line ${String(source.lineNo)} can come back`,
          };
        }),
      );
    }

    const computed = computeReturn(
      noteSourceOf({ ...invoice, lines: sourceLines }),
      returning.map((line) => ({
        lineIndex: line.lineNo,
        quantity: Number(wanted.get(line.id)) / 1000,
        previouslyReturnedQuantity: sofar(line.id).returnedQuantity,
      })),
      true,
    );
    this.assertCreditRoom(returning, computed, sofar, (index) => {
      const lineId = String(returning[index]?.id);
      return `lines.${String(input.lines.findIndex((line) => line.invoiceLineId === lineId))}.quantity`;
    });
    const note = await this.issue(tx, auth, {
      kind: 'credit_note',
      reason: 'return',
      invoice,
      sourceLines: returning,
      computed,
      quantities: returning.map((line) => Number(wanted.get(line.id)) / 1000),
      stockPosting: 'on_issue',
      note: input.note ?? null,
      schemeReference: null,
      today,
    });
    const number = formatDocumentNumber(
      'SR',
      await nextDocumentNumber(tx, organizationId, 'sales_return'),
    );

    // Back on the shelf, or back and then written off, both visible in the stock ledger (§4.2).
    await postStockMovements(
      tx,
      input.lines.flatMap((line) => {
        const { variantId } = lineOf(line.invoiceLineId, '');
        const movement = {
          organizationId,
          storeId: invoice.storeId,
          variantId,
          referenceType: 'tax_document',
          referenceId: note.id,
          createdByMemberId: auth.memberId,
        };
        const back = {
          ...movement,
          movementType: 'sale_return' as const,
          quantity: line.quantity,
          note: `Return ${number}`,
        };
        return line.disposition === 'restock'
          ? [back]
          : [
              back,
              {
                ...movement,
                movementType: 'damage' as const,
                quantity: -line.quantity,
                note: `Damaged on return ${number}${line.reason ? `: ${line.reason}` : ''}`,
              },
            ];
      }),
    );
    const [created] = (await tx
      .insert(salesReturns)
      .values({
        organizationId,
        number,
        invoiceId: invoice.id,
        storeId: invoice.storeId,
        status: 'completed',
        creditNoteId: note.id,
        note: input.note,
        createdByMemberId: auth.memberId,
        completedAt: sql`now()`,
      })
      .returning()) as [typeof salesReturns.$inferSelect];
    await tx.insert(salesReturnLines).values(
      input.lines.map((line) => ({
        organizationId,
        returnId: created.id,
        invoiceLineId: line.invoiceLineId,
        quantity: line.quantity,
        disposition: line.disposition,
        reason: line.reason,
      })),
    );
    return salesReturnView(tx, created);
  }

  private async valueNoteIn(
    tx: Transaction,
    auth: AuthContext,
    kind: NoteKind,
    reason: NoteReason,
    input: DebitNoteInput,
    schemeReference: string | undefined,
  ): Promise<NoteView> {
    const {
      invoice,
      lines: sourceLines,
      today,
    } = await this.openInvoice(tx, auth, input.invoiceId);
    if (kind === 'debit_note') {
      if (invoice.kind === 'bill_of_supply') {
        throw new ConflictException(
          'A composition store charges no tax: correct a bill of supply with a new bill instead',
        );
      }
    } else {
      this.assertCreditWindow(invoice, today);
    }
    const lineOf = this.lineFinder(sourceLines);
    const adjusted = input.lines.map((line, index) =>
      lineOf(line.invoiceLineId, `lines.${String(index)}.invoiceLineId`),
    );
    const computed = computeAdjustment(
      noteSourceOf({ ...invoice, lines: sourceLines }),
      input.lines.map((line, index) => ({
        lineIndex: Number(adjusted[index]?.lineNo),
        valuePaise: line.valuePaise,
      })),
      input.valueIncludesTax ?? invoice.priceMode === 'inclusive',
      true,
    );
    if (kind === 'credit_note') {
      const sofar = await adjustedSoFar(tx, invoice.id);
      this.assertCreditRoom(
        adjusted,
        computed,
        sofar,
        (index) => `lines.${String(index)}.valuePaise`,
      );
    }
    const issued = await this.issue(tx, auth, {
      kind,
      reason,
      invoice,
      sourceLines: adjusted,
      computed,
      quantities: adjusted.map((line) => line.quantity),
      stockPosting: 'none',
      note: input.note ?? null,
      schemeReference: schemeReference ?? null,
      today,
    });
    return noteView(tx, issued);
  }

  /** The invoice locked for the note, its lines in order, and today in India. */
  private async openInvoice(tx: Transaction, auth: AuthContext, invoiceId: string) {
    // The party first, then the invoice: the order payments and cancelling lock them in.
    const { partyId } = await loadDocument(tx, auth, invoiceId);
    if (partyId !== null) await lockParty(tx, auth.organization.id, partyId);
    const invoice = await loadDocument(tx, auth, invoiceId, true);
    if (invoice.kind !== 'invoice' && invoice.kind !== 'bill_of_supply') {
      throw fieldError('invoiceId', 'Choose a tax invoice or bill of supply');
    }
    if (invoice.status !== 'issued') {
      throw new ConflictException(
        `Only an issued invoice takes notes; this one is ${invoice.status}`,
      );
    }
    const lines = await tx
      .select()
      .from(taxDocumentLines)
      .where(eq(taxDocumentLines.documentId, invoiceId))
      .orderBy(asc(taxDocumentLines.lineNo));
    return { invoice, lines, today: await indiaToday(tx) };
  }

  /** s.34(2): no credit note after 30 November following the supply's financial year. */
  private assertCreditWindow(invoice: TaxDocumentRow, today: string): void {
    const window = creditNoteWindow(String(invoice.issuedOn), today);
    if (window.status === 'closed') {
      throw new ConflictException(
        `The last day for a credit note on this invoice was ${window.deadline} (s.34(2))`,
      );
    }
  }

  /** Finds a line of the invoice by id, or refuses the request at `path`. */
  private lineFinder(lines: readonly InvoiceLineRow[]) {
    return (id: string, path: string): InvoiceLineRow => {
      const line = lines.find((candidate) => candidate.id === id);
      if (!line) throw fieldError(path, 'Not a line of this invoice');
      return line;
    };
  }

  /**
   * A line is never credited more than it was charged: what credit notes took
   * off, plus this note, stays within its taxable value plus what debit notes added.
   */
  private assertCreditRoom(
    lines: readonly InvoiceLineRow[],
    computed: CreditNote,
    sofar: Awaited<ReturnType<typeof adjustedSoFar>>,
    pathOf: (index: number) => string,
  ): void {
    const issues = computed.lines.flatMap((credit, index) => {
      const source = nth(lines, index);
      const done = sofar(source.id);
      const room = source.taxablePaise + done.debitedTaxablePaise - done.creditedTaxablePaise;
      return credit.taxablePaise > room
        ? [
            {
              path: pathOf(index),
              message: `Line ${String(source.lineNo)} has ${String(room)} paise of taxable value left to credit`,
            },
          ]
        : [];
    });
    if (issues.length > 0) {
      throw unprocessable('This would credit more than was charged', issues);
    }
  }

  /**
   * Spec §4.5: a credit note pays what is still due on its invoice; anything
   * over that is the party's advance, to use on later bills or refund (3a).
   */
  private async settle(
    tx: Transaction,
    auth: AuthContext,
    invoice: TaxDocumentRow,
    note: TaxDocumentRow,
  ): Promise<void> {
    const partyId = String(invoice.partyId);
    const [paid] = await tx
      .select({ paise: sql<number>`coalesce(sum(${allocations.amountPaise}), 0)`.mapWith(Number) })
      .from(allocations)
      .where(eq(allocations.documentId, invoice.id));
    const due = invoice.totalPaise - Number(paid?.paise);
    const applied = Math.min(due, note.totalPaise);
    if (applied > 0) {
      await tx.insert(allocations).values({
        organizationId: auth.organization.id,
        partyId,
        creditNoteId: note.id,
        documentId: invoice.id,
        amountPaise: applied,
        createdByMemberId: auth.memberId,
      });
    }
    if (note.totalPaise > applied) {
      await adjustPartyAdvance(tx, partyId, note.totalPaise - applied);
    }
  }

  /** Numbers, snapshots, issues and posts a note; returns the issued row. */
  private async issue(
    tx: Transaction,
    auth: AuthContext,
    pending: PendingNote,
  ): Promise<TaxDocumentRow> {
    const organizationId = auth.organization.id;
    const { invoice, computed, kind } = pending;
    // An issued invoice always has its supplier, party and place of supply.
    const gstin = String(invoice.supplierGstin);
    const partyId = String(invoice.partyId);
    const [store] = (await tx
      .select({ code: stores.code })
      .from(stores)
      .where(eq(stores.id, invoice.storeId))) as [{ code: string }];
    const { seriesId, number, fy } = await takeDocumentNumber(
      tx,
      organizationId,
      { id: invoice.storeId, code: store.code, gstin },
      kind,
      pending.today,
    );

    // Lines, tax rows and the link are written while the note is still a draft.
    const [draft] = (await tx
      .insert(taxDocuments)
      .values({
        organizationId,
        kind,
        storeId: invoice.storeId,
        partyId,
        buyerName: invoice.buyerName,
        buyerGstin: invoice.buyerGstin,
        buyerAddress: invoice.buyerAddress,
        buyerStateCode: invoice.buyerStateCode,
        shipToName: invoice.shipToName,
        shipToAddress: invoice.shipToAddress,
        shipToStateCode: invoice.shipToStateCode,
        priceMode: invoice.priceMode,
        projectId: invoice.projectId,
        influencerPartyId: invoice.influencerPartyId,
        reason: pending.reason,
        note: pending.note,
        schemeReference: pending.schemeReference,
        createdByMemberId: auth.memberId,
      })
      .returning({ id: taxDocuments.id })) as [{ id: string }];
    const rows = computed.lines.map((line, index) => {
      return {
        line,
        source: nth(pending.sourceLines, index),
        quantity: nth(pending.quantities, index),
      };
    });
    await tx.insert(taxDocumentLines).values(
      rows.map(({ line, source, quantity }, index) => ({
        organizationId,
        documentId: draft.id,
        lineNo: index + 1,
        variantId: source.variantId,
        description: source.description,
        hsnCode: source.hsnCode,
        uqc: source.uqc,
        quantity,
        // A returned unit is credited at its invoice price; a value note carries values only.
        unitPricePaise: pending.reason === 'return' ? source.unitPricePaise : 0,
        grossPaise: line.taxablePaise,
        taxablePaise: line.taxablePaise,
        taxCategoryId: source.taxCategoryId,
        rateBps: source.rateBps,
        taxNature: source.taxNature,
        cessBps: source.cessBps,
        cgstPaise: line.cgstPaise,
        sgstPaise: line.sgstPaise,
        igstPaise: line.igstPaise,
        cessPaise: line.cessPaise,
        totalPaise: line.totalPaise,
        sourceLineId: source.id,
      })),
    );
    const taxRows = new Map<string, typeof taxDocumentTaxRows.$inferInsert>();
    for (const { line, source } of rows) {
      if (line.rate === null) continue;
      // Every issued invoice line has its HSN code (snapshotted at issue).
      const hsnCode = String(source.hsnCode);
      const key = `${hsnCode}|${String(line.rate.rateBasisPoints)}|${String(line.rate.cessBasisPoints)}`;
      const row = taxRows.get(key) ?? {
        organizationId,
        documentId: draft.id,
        hsnCode,
        rateBps: line.rate.rateBasisPoints,
        cessBps: line.rate.cessBasisPoints,
        taxablePaise: 0,
        cgstPaise: 0,
        sgstPaise: 0,
        igstPaise: 0,
        cessPaise: 0,
      };
      taxRows.set(key, {
        ...row,
        taxablePaise: row.taxablePaise + line.taxablePaise,
        cgstPaise: row.cgstPaise + line.cgstPaise,
        sgstPaise: row.sgstPaise + line.sgstPaise,
        igstPaise: row.igstPaise + line.igstPaise,
        cessPaise: row.cessPaise + line.cessPaise,
      });
    }
    if (taxRows.size > 0) await tx.insert(taxDocumentTaxRows).values([...taxRows.values()]);
    await tx.insert(taxDocumentLinks).values({
      organizationId,
      fromDocumentId: draft.id,
      toDocumentId: invoice.id,
      kind: 'note_of',
    });

    const totals = computed.totals;
    const [issued] = (await tx
      .update(taxDocuments)
      .set({
        status: 'issued',
        seriesId,
        number,
        fy,
        issuedOn: pending.today,
        issuedAt: sql`now()`,
        issuedByMemberId: auth.memberId,
        supplierGstin: gstin,
        supplierStateCode: invoice.supplierStateCode,
        supplierLegalName: invoice.supplierLegalName,
        supplierTradeName: invoice.supplierTradeName,
        supplierAddress: invoice.supplierAddress,
        placeOfSupplyCode: invoice.placeOfSupplyCode,
        supplyType: invoice.supplyType,
        gstClass: invoice.gstClass,
        taxablePaise: totals.taxablePaise,
        cgstPaise: totals.cgstPaise,
        sgstPaise: totals.sgstPaise,
        igstPaise: totals.igstPaise,
        cessPaise: totals.cessPaise,
        roundOffPaise: totals.roundOffPaise,
        totalPaise: totals.payablePaise,
        stockPosting: pending.stockPosting,
        // s.34(2) proviso: a B2B credit note waits on the buyer reversing the input credit.
        itcReversalStatus: kind === 'credit_note' && invoice.buyerGstin !== null ? 'unknown' : null,
        updatedAt: sql`now()`,
      })
      .where(eq(taxDocuments.id, draft.id))
      .returning()) as [TaxDocumentRow];

    if (totals.payablePaise > 0) {
      const credit = kind === 'credit_note';
      // A credit note lowers what the party owes; any excess is theirs as a refund or advance (3a).
      await postPartyLedger(tx, [
        {
          organizationId,
          partyId,
          storeId: invoice.storeId,
          entryOn: pending.today,
          entryType: kind,
          amountPaise: credit ? -totals.payablePaise : totals.payablePaise,
          referenceType: 'tax_document',
          referenceId: issued.id,
          note: number,
          createdByMemberId: auth.memberId,
        },
      ]);
      if (credit) await this.settle(tx, auth, invoice, issued);
    }
    if (kind === 'credit_note') {
      await reverseLoyaltyForNote(tx, {
        organizationId,
        invoiceId: invoice.id,
        invoiceTaxablePaise: invoice.taxablePaise,
        noteId: issued.id,
        noteNumber: number,
        creditedTaxablePaise: totals.taxablePaise,
        memberId: auth.memberId,
      });
      await reverseInfluencerPointsForNote(tx, {
        organizationId,
        invoiceId: invoice.id,
        noteId: issued.id,
        noteNumber: number,
        memberId: auth.memberId,
      });
    }
    return issued;
  }
}
