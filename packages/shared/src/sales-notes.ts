/**
 * Sales returns, credit notes and debit notes (MVP 2 round 3c, spec §2.9, §4.5):
 * the time limit of s.34(2), how an issued invoice read back from storage feeds
 * the GST engine, and the shapes the API returns. The tax itself comes from the
 * engine (`computeReturn`, `computeAdjustment` in ./gst).
 */
import type { ListPageInfo } from './list-page.js';
import type { NoteSource } from './gst/returns.js';
import { stateTaxLabel } from './gst/states.js';
import type { Permission } from './permissions.js';
import type { TaxDocumentLineView, TaxDocumentStatus, TaxDocumentView } from './tax-documents.js';

/** Returned goods go back on the shelf, or are written off as damaged. */
export const RETURN_DISPOSITIONS = ['restock', 'damage'] as const;
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number];

/** s.34(1): why a credit note lowers what was charged. `return` comes only with a sales return. */
export const CREDIT_NOTE_REASONS = ['return', 'discount', 'overcharge', 'deficient'] as const;
export type CreditNoteReason = (typeof CREDIT_NOTE_REASONS)[number];
/** Credit notes raised on their own, without goods coming back. */
export const VALUE_CREDIT_NOTE_REASONS = ['discount', 'overcharge', 'deficient'] as const;
export type ValueCreditNoteReason = (typeof VALUE_CREDIT_NOTE_REASONS)[number];
/** s.34(3): a debit note raises what was charged. */
export const DEBIT_NOTE_REASONS = ['undercharge'] as const;
export type DebitNoteReason = (typeof DEBIT_NOTE_REASONS)[number];
export type NoteReason = CreditNoteReason | DebitNoteReason;
export type NoteKind = 'credit_note' | 'debit_note';

/**
 * s.34(2) proviso (from 1 Oct 2025): the supplier's tax comes down on a B2B
 * credit note only once the registered buyer has reversed the input credit.
 * `unknown` until IMS data arrives (release 2.3, [CA-14]).
 */
export const ITC_REVERSAL_STATUSES = ['unknown', 'reversed', 'not_reversed'] as const;
export type ItcReversalStatus = (typeof ITC_REVERSAL_STATUSES)[number];

/** Who may take goods back and issue credit and debit notes (spec §3.5). */
export const NOTES_PERMISSION: Permission = 'billing:notes';

/** A credit note this close to its last day is flagged on the invoice. */
export const CREDIT_NOTE_WARNING_DAYS = 30;

/**
 * s.34(2): the last day to issue a credit note for a supply, 30 November after
 * the end of its financial year (2026-05-10 → 2027-11-30). The annual return,
 * when filed earlier, ends it sooner; the business is told so, the app cannot know.
 */
export function creditNoteDeadline(invoiceIssuedOn: string): string {
  const year = Number(invoiceIssuedOn.slice(0, 4));
  const fyStart = Number(invoiceIssuedOn.slice(5, 7)) >= 4 ? year : year - 1;
  return `${String(fyStart + 1)}-11-30`;
}

export type CreditNoteWindowStatus = 'open' | 'closing' | 'closed';

export interface CreditNoteWindow {
  readonly deadline: string;
  /** `closing` within CREDIT_NOTE_WARNING_DAYS of the deadline, `closed` after it. */
  readonly status: CreditNoteWindowStatus;
  /** Days from `today` to the deadline; negative once it has passed. */
  readonly daysLeft: number;
}

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

/** Whether a credit note may still be issued on `today` (India date, from the database clock). */
export function creditNoteWindow(invoiceIssuedOn: string, today: string): CreditNoteWindow {
  const deadline = creditNoteDeadline(invoiceIssuedOn);
  const daysLeft = dayNumber(deadline) - dayNumber(today);
  const status =
    daysLeft < 0 ? 'closed' : daysLeft <= CREDIT_NOTE_WARNING_DAYS ? 'closing' : 'open';
  return { deadline, status, daysLeft };
}

/**
 * Loyalty points a credit note takes back (spec §4.5, §4.7, [PO-6]): the points
 * the invoice earned, in proportion to the taxable value credited, rounded half
 * up and never more than were earned.
 */
export function loyaltyPointsToReverse(
  earnedPoints: number,
  invoiceTaxablePaise: number,
  creditedTaxablePaise: number,
): number {
  if (earnedPoints <= 0 || invoiceTaxablePaise <= 0) return 0;
  const share = Math.round((earnedPoints * creditedTaxablePaise) / invoiceTaxablePaise);
  return Math.min(earnedPoints, share);
}

/** One stored line of an issued invoice, as much as a note needs. */
export interface StoredInvoiceLine {
  readonly lineNo: number;
  readonly taxCategoryId: string | null;
  readonly quantity: number;
  /** Null on a bill of supply. */
  readonly rateBps: number | null;
  /** Ad valorem cess rate; absent (as in TaxDocumentLineView) means none. */
  readonly cessBps?: number | null;
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly cessPaise: number;
}

export interface StoredInvoice {
  readonly supplyType: 'intra_state' | 'inter_state' | null;
  readonly placeOfSupplyCode: string | null;
  readonly lines: readonly StoredInvoiceLine[];
}

/**
 * An issued invoice as the GST engine's note source: line `index` is the line
 * number, amounts are what was charged, the rate is the one applied then (a 0%
 * line counts as nil-rated; the nature does not change a note's tax).
 */
export function noteSourceOf(invoice: StoredInvoice): NoteSource {
  const { supplyType, placeOfSupplyCode } = invoice;
  if (supplyType === null || placeOfSupplyCode === null) {
    throw new RangeError('Only an issued invoice can have notes');
  }
  return {
    supplyType,
    placeOfSupply: placeOfSupplyCode,
    stateTaxLabel: stateTaxLabel(placeOfSupplyCode),
    lines: invoice.lines.map((line) => ({
      index: line.lineNo,
      categoryCode: String(line.taxCategoryId),
      quantityMilli: Math.round(line.quantity * 1000),
      rate:
        line.rateBps === null
          ? null
          : {
              nature: line.rateBps > 0 ? 'taxable' : 'nil_rated',
              rateBasisPoints: line.rateBps,
              cessBasisPoints: line.cessBps ?? 0,
            },
      taxablePaise: line.taxablePaise,
      cgstPaise: line.cgstPaise,
      sgstPaise: line.sgstPaise,
      igstPaise: line.igstPaise,
      cessPaise: line.cessPaise,
    })),
  };
}

// API shapes ---------------------------------------------------------------

export interface NoteLineView extends TaxDocumentLineView {
  /** The invoice line this note line adjusts. */
  readonly sourceLineId: string | null;
}

/** An issued credit or debit note with the invoice it adjusts. */
export interface NoteView extends Omit<TaxDocumentView, 'lines' | 'kind'> {
  readonly kind: NoteKind;
  readonly reason: NoteReason;
  readonly itcReversalStatus: ItcReversalStatus | null;
  /** s.15(3)(b): the scheme a discount credit note was agreed under before the sale. */
  readonly schemeReference: string | null;
  readonly invoice: {
    readonly id: string;
    readonly number: string | null;
    readonly issuedOn: string | null;
  };
  /** The sales return that issued it (credit notes for returned goods). */
  readonly salesReturnId: string | null;
  readonly lines: NoteLineView[];
}

export interface NoteSummary {
  readonly id: string;
  readonly kind: NoteKind;
  readonly status: TaxDocumentStatus;
  readonly storeId: string;
  readonly number: string | null;
  readonly issuedOn: string | null;
  readonly reason: NoteReason;
  readonly buyerName: string | null;
  readonly totalPaise: number;
  readonly itcReversalStatus: ItcReversalStatus | null;
  readonly invoice: { readonly id: string; readonly number: string | null };
}

export interface NotePage extends ListPageInfo {
  readonly items: NoteSummary[];
}

export interface SalesReturnLineView {
  readonly id: string;
  readonly invoiceLineId: string;
  readonly description: string | null;
  readonly quantity: number;
  readonly disposition: ReturnDisposition;
  readonly reason: string | null;
}

/** A completed return: goods back in stock (or written off) and its credit note. */
export interface SalesReturnView {
  readonly id: string;
  readonly number: string;
  readonly invoiceId: string;
  readonly storeId: string;
  readonly completedAt: string;
  readonly note: string | null;
  readonly lines: SalesReturnLineView[];
  readonly creditNote: NoteView;
}

/** What has been returned and adjusted on one invoice line so far. */
export interface InvoiceAdjustmentLine {
  readonly invoiceLineId: string;
  readonly lineNo: number;
  readonly soldQuantity: number;
  readonly returnedQuantity: number;
  /** Taxable value taken off by credit notes (returns included). */
  readonly creditedTaxablePaise: number;
  /** Taxable value added by debit notes. */
  readonly debitedTaxablePaise: number;
}

/** GET /invoices/:id/adjustments: an invoice's returns, notes and what is left to credit. */
export interface InvoiceAdjustments {
  readonly invoiceId: string;
  /** Null for a document that takes no credit notes (a draft or cancelled one). */
  readonly creditNoteWindow: CreditNoteWindow | null;
  readonly lines: InvoiceAdjustmentLine[];
  readonly notes: NoteSummary[];
}
