import type { ListPageInfo } from './list-page.js';
import type { Discount } from './gst/types.js';
import type { PrintBankDetails } from './invoice-print/types.js';
import type { LineTintRequest } from './paint-api.js';
import type { TallyParty, TallyReceipt } from './tally/types.js';
import type { TaxDocumentKind, TaxDocumentView } from './tax-documents.js';

/**
 * Payments, allocations, the cash register and issue-with-payments (MVP 2,
 * Sell & Bill, round 3a; spec §4.4, §4.6, §5.1, §5.5): the request and
 * response shapes of the API, shared with the POS screen and returns.
 * Every amount is integer paise; every date an India-time `YYYY-MM-DD`.
 */

/** How money moves (`payment_modes.kind`); a business may have several modes of one kind. */
export const PAYMENT_MODE_KINDS = [
  'cash',
  'upi',
  'card',
  'bank_transfer',
  'cheque',
  'other',
  /** Paid through a payment link (P2-M32): only the gateway's webhook records these. */
  'upi_link',
] as const;
export type PaymentModeKind = (typeof PAYMENT_MODE_KINDS)[number];

/** `in`: money received from a party; `out`: a refund paid to one. */
export const PAYMENT_DIRECTIONS = ['in', 'out'] as const;
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

/** A received cheque until the bank clears or returns it. */
export const CHEQUE_STATUSES = ['pending', 'cleared', 'bounced'] as const;
export type ChequeStatus = (typeof CHEQUE_STATUSES)[number];

/** Cash put into or taken out of a register drawer other than by a sale or refund. */
export const REGISTER_MOVEMENT_KINDS = ['pay_in', 'pay_out', 'bank_deposit'] as const;
export type RegisterMovementKind = (typeof REGISTER_MOVEMENT_KINDS)[number];

export const REGISTER_SESSION_STATUSES = ['open', 'closed'] as const;
export type RegisterSessionStatus = (typeof REGISTER_SESSION_STATUSES)[number];

/** Notes and coins counted at day end, in paise: ₹500 down to ₹1. */
export const CASH_DENOMINATIONS_PAISE = [
  50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100,
] as const;

/** The modes every business starts with (spec §3.3); add "other" ones for finance companies or wallets. */
export const DEFAULT_PAYMENT_MODES: readonly { kind: PaymentModeKind; name: string }[] = [
  { kind: 'cash', name: 'Cash' },
  { kind: 'upi', name: 'UPI' },
  { kind: 'card', name: 'Card' },
  { kind: 'bank_transfer', name: 'Bank transfer' },
  { kind: 'cheque', name: 'Cheque' },
];

/** Cash counted by denomination: how many of each (paise value as the key). */
export function countedCash(denominations: Readonly<Record<string, number>>): number {
  return Object.entries(denominations).reduce(
    (total, [value, count]) => total + Number(value) * count,
    0,
  );
}

// Payment modes ---------------------------------------------------------------

/** GET /payment-modes. */
export interface PaymentModeView {
  readonly id: string;
  readonly kind: PaymentModeKind;
  readonly name: string;
  readonly isActive: boolean;
}

/** POST /payment-modes. */
export interface CreatePaymentModeRequest {
  readonly kind: PaymentModeKind;
  readonly name: string;
}

/** PATCH /payment-modes/:id: rename, or switch off (kept on old payments). */
export interface UpdatePaymentModeRequest {
  readonly name?: string;
  readonly isActive?: boolean;
}

// Payments and allocations ----------------------------------------------------

/**
 * Where part of a payment goes: an issued invoice, bill of supply or debit
 * note (`documentId`), or an opening balance or charge in the party ledger
 * (`partyLedgerId`). Exactly one of the two.
 */
export interface AllocationTarget {
  readonly documentId?: string;
  readonly partyLedgerId?: string;
}

export interface AllocationRequest extends AllocationTarget {
  readonly amountPaise: number;
}

/**
 * POST /payments (`Idempotency-Key` header): money received from a party.
 * `allocations` omitted: oldest open documents first; `[]`: all of it stays
 * as an advance. Whatever is not allocated is an advance, with a GST receipt
 * voucher number when the store is registered.
 */
export interface RecordPaymentRequest {
  readonly storeId: string;
  readonly partyId: string;
  readonly modeId: string;
  readonly amountPaise: number;
  /** Defaults to today (India). Never in the future. */
  readonly receivedOn?: string;
  /** UTR, card slip or cheque number. Required for a cheque. */
  readonly reference?: string;
  /** The date written on a cheque. Required for a cheque. */
  readonly chequeDate?: string;
  /** Cash only: what the customer handed over (the change is the difference). */
  readonly tenderedPaise?: number;
  /** The open register session for cash; found by store when there is only one. */
  readonly registerSessionId?: string;
  /** A payment gateway's id for later matching (2.1). */
  readonly gatewayReference?: string;
  readonly note?: string;
  readonly allocations?: readonly AllocationRequest[];
}

/** POST /payments/:id/allocate: puts unallocated money against documents. Omitted: oldest first. */
export interface AllocatePaymentRequest {
  readonly allocations?: readonly AllocationRequest[];
}

/** POST /payments/:id/clear: the bank credited the cheque. */
export interface ClearChequeRequest {
  /** Defaults to today. */
  readonly clearedOn?: string;
}

/**
 * POST /payments/:id/bounce: the bank returned the cheque. Its allocations
 * are undone and the party owes the amount again; a charge is added on top
 * when given (a non-GST recovery until [CA-11] is answered).
 */
export interface BounceChequeRequest {
  readonly bouncedOn?: string;
  readonly reason: string;
  readonly chargePaise?: number;
}

/**
 * POST /payments/:id/refund (`Idempotency-Key` header): pays back part of a
 * payment that is not allocated. A refund of an advance that had a receipt
 * voucher gets a refund voucher number.
 */
export interface RefundRequest {
  readonly modeId: string;
  readonly amountPaise: number;
  readonly paidOn?: string;
  readonly reference?: string;
  readonly registerSessionId?: string;
  readonly note?: string;
}

/** Why an allocation was undone: by hand (`undone`), or its cheque bounced (`cheque_bounce`). */
export const ALLOCATION_REVERSAL_REASONS = ['undone', 'cheque_bounce'] as const;
export type AllocationReversalReason = (typeof ALLOCATION_REVERSAL_REASONS)[number];

/** One allocation row: positive puts money against a document, negative undoes an earlier row. */
export interface AllocationView {
  readonly id: string;
  readonly paymentId: string | null;
  readonly creditNoteId: string | null;
  readonly documentId: string | null;
  readonly partyLedgerId: string | null;
  readonly refundPaymentId: string | null;
  /** The document's number, the refund's number, or the ledger entry's note. */
  readonly targetNumber: string | null;
  readonly amountPaise: number;
  readonly reversesAllocationId: string | null;
  /** Why a reversing row undid its allocation; null on an ordinary row. */
  readonly reversalReason: AllocationReversalReason | null;
  /** True once a later row has undone this one. */
  readonly reversed: boolean;
  readonly createdAt: string;
}

/** A payment received (`in`) or a refund paid (`out`). Never edited; a bounce adds rows. */
export interface PaymentView {
  readonly id: string;
  /** `RC-000123` for money in, `RF-000012` for a refund. */
  readonly number: string;
  /** The GST receipt voucher (`AMPA/26-27/00045`) or refund voucher number, when there is one. */
  readonly voucherNumber: string | null;
  readonly direction: PaymentDirection;
  readonly storeId: string;
  readonly partyId: string;
  readonly partyName: string;
  readonly mode: { readonly id: string; readonly kind: PaymentModeKind; readonly name: string };
  readonly amountPaise: number;
  readonly tenderedPaise: number | null;
  readonly changePaise: number | null;
  readonly receivedOn: string;
  readonly reference: string | null;
  readonly chequeDate: string | null;
  readonly chequeStatus: ChequeStatus | null;
  readonly chequeClearedOn: string | null;
  readonly chequeBouncedOn: string | null;
  readonly bounceReason: string | null;
  readonly registerSessionId: string | null;
  readonly gatewayReference: string | null;
  readonly note: string | null;
  /** Money in: amount less live allocations (an advance). Refunds: 0. */
  readonly unallocatedPaise: number;
  readonly allocations: readonly AllocationView[];
  /** Null when a gateway reported the payment (a payment link): no member took it. */
  readonly createdByMemberId: string | null;
  /** The payment link it paid, when a gateway reported it. */
  readonly paymentLinkId: string | null;
  readonly createdAt: string;
}

export interface PaymentSummary {
  readonly id: string;
  readonly number: string;
  readonly voucherNumber: string | null;
  readonly direction: PaymentDirection;
  readonly storeId: string;
  readonly partyId: string;
  readonly partyName: string;
  readonly modeKind: PaymentModeKind;
  readonly modeName: string;
  readonly amountPaise: number;
  readonly receivedOn: string;
  readonly chequeStatus: ChequeStatus | null;
  readonly unallocatedPaise: number;
}

/** GET /payments?storeId&partyId&direction&modeKind&chequeStatus&from&to&q&limit&offset. */
export interface PaymentPage extends ListPageInfo {
  readonly items: PaymentSummary[];
}

// Issue with payments (the POS) -----------------------------------------------

/** One way the customer pays at the counter. */
export interface IssuePaymentRequest {
  readonly modeId: string;
  readonly amountPaise: number;
  readonly reference?: string;
  readonly chequeDate?: string;
  /** Cash: what was handed over; the change is returned, never kept on account. */
  readonly tenderedPaise?: number;
  readonly registerSessionId?: string;
  readonly gatewayReference?: string;
}

/**
 * POST /invoices/:id/issue (`Idempotency-Key` header): issues the draft and
 * takes its payments in one transaction. A walk-in bill must be paid in full;
 * a customer's bill may be paid in part (the rest stays on their account).
 * Payments never exceed what the bill leaves due.
 */
/** A line of POST/PUT /invoices (a draft or held bill). */
export interface DraftInvoiceLineRequest {
  readonly variantId: string;
  readonly quantity: number;
  /** Defaults to the variant's selling price. */
  readonly unitPricePaise?: number;
  readonly discount?: Discount;
  /** The shade it is tinted to, written with the line (round 5a); left out = untinted. */
  readonly tint?: LineTintRequest;
  /** A mistinted can this line sells: its base, its whole quantity, at the price given. */
  readonly mistintCanId?: string;
}

export interface IssueInvoiceRequest {
  readonly einvoice?: { readonly irn: string; readonly ackNo: string; readonly ackAt?: string };
  readonly payments?: readonly IssuePaymentRequest[];
  /** Use the customer's advances (oldest first) before the new payments. */
  readonly allocateAdvances?: boolean;
}

/**
 * What printing an invoice needs from the business, beside the document itself
 * (spec §5.4): the business's settings as they were when it was issued.
 */
export interface InvoicePrintSettings {
  /** Bank details from the sales settings; null when none are given. */
  readonly bank: PrintBankDetails | null;
  /** Terms and conditions from the sales settings, in order. */
  readonly terms: readonly string[];
  /** The issuing GSTIN's aggregate turnover band, read for the HSN digits rule (§2.7). */
  readonly aggregateTurnoverPaise: number;
}

/**
 * GET /invoices/:id/print: an issued invoice or bill of supply with what printing it
 * needs, to reprint it on A4 or the 80 mm counter printer (the same view model as at
 * the counter, `printViewOf`). The settings are today's, as on the first print.
 */
export interface PrintableInvoiceView extends TaxDocumentView {
  readonly print: InvoicePrintSettings;
}

/** What POST /invoices/:id/issue returns: the invoice, its payments and what is still due. */
export interface IssuedInvoiceView extends PrintableInvoiceView {
  readonly payments: PaymentView[];
  /** Advances and payments allocated to this invoice. */
  readonly paidPaise: number;
  readonly outstandingPaise: number;
  /** Cash handed back, across the cash payments. */
  readonly changePaise: number;
}

// Party ledger ----------------------------------------------------------------

export type PartyLedgerEntryKind =
  | 'opening'
  | 'invoice'
  | 'debit_note'
  | 'credit_note'
  | 'payment_in'
  | 'refund_out'
  | 'cheque_bounce'
  | 'adjustment'
  | 'cancellation';

export interface PartyLedgerEntryView {
  readonly id: string;
  readonly entryOn: string;
  readonly entryType: PartyLedgerEntryKind;
  /** Positive: the party owes more. */
  readonly amountPaise: number;
  readonly referenceType: string | null;
  readonly referenceId: string | null;
  /** The invoice, note or payment number the entry refers to, when it refers to one. */
  readonly referenceNumber: string | null;
  readonly note: string | null;
  /** Balance after this entry. */
  readonly balancePaise: number;
}

/** Something the party still owes: a document, or an opening balance or charge. */
export interface OpenDocumentView {
  readonly documentId: string | null;
  readonly partyLedgerId: string | null;
  readonly kind: TaxDocumentKind | 'opening' | 'charge';
  readonly number: string | null;
  readonly issuedOn: string;
  readonly dueOn: string | null;
  readonly totalPaise: number;
  readonly allocatedPaise: number;
  readonly outstandingPaise: number;
}

/**
 * GET /parties/:id/ledger?from&to&limit&offset&cursor: oldest first, a page at a time (round 6c).
 * `openingPaise` is the balance before this page's first entry (the period's opening on the
 * first page) and `closingPaise` the balance after its last; `nextCursor` asks for the rest,
 * and `total` counts the period's entries (up to the list cap).
 */
export interface PartyLedgerView extends ListPageInfo {
  readonly partyId: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly openingPaise: number;
  readonly entries: PartyLedgerEntryView[];
  readonly closingPaise: number;
  /** Today's balance and unallocated money, whatever the period. */
  readonly balancePaise: number;
  readonly advancePaise: number;
  /** Oldest first. */
  readonly openDocuments: OpenDocumentView[];
}

// Register --------------------------------------------------------------------

/** POST /registers/:code/open. */
export interface OpenRegisterRequest {
  readonly storeId: string;
  readonly openingFloatPaise: number;
  readonly note?: string;
}

/** POST /register-sessions/:id/movements. */
export interface CashMovementRequest {
  readonly kind: RegisterMovementKind;
  readonly amountPaise: number;
  readonly reason: string;
}

/**
 * POST /register-sessions/:id/close: the cash counted, by denomination
 * (`{"50000": 3, "100": 7}`) or as a total; both must agree when both are sent.
 */
export interface CloseRegisterRequest {
  readonly denominations?: Readonly<Record<string, number>>;
  readonly countedCashPaise?: number;
  readonly note?: string;
}

export interface CashMovementView {
  readonly id: string;
  readonly kind: RegisterMovementKind;
  readonly amountPaise: number;
  readonly reason: string;
  readonly createdByMemberId: string;
  readonly createdAt: string;
}

/** Money taken in the session by one mode (cash, UPI, card, cheque…). */
export interface RegisterModeTotal {
  readonly modeId: string;
  readonly kind: PaymentModeKind;
  readonly name: string;
  readonly inPaise: number;
  readonly outPaise: number;
  readonly count: number;
}

export interface RegisterSessionView {
  readonly id: string;
  readonly storeId: string;
  readonly registerCode: string;
  readonly status: RegisterSessionStatus;
  readonly openedByMemberId: string;
  /** Who opened and who closed it, by name, for the Z-report. */
  readonly openedBy: string;
  readonly openedAt: string;
  readonly openingFloatPaise: number;
  readonly openingNote: string | null;
  /** Float + cash in − cash out ± movements; live while open, fixed at close. */
  readonly expectedCashPaise: number;
  readonly countedCashPaise: number | null;
  /** Counted − expected: negative when cash is short. */
  readonly variancePaise: number | null;
  readonly denominations: Readonly<Record<string, number>> | null;
  readonly closedByMemberId: string | null;
  readonly closedBy: string | null;
  readonly closedAt: string | null;
  readonly closingNote: string | null;
  readonly cashInPaise: number;
  readonly cashOutPaise: number;
  readonly movements: CashMovementView[];
  readonly modeTotals: RegisterModeTotal[];
}

/** GET /register-sessions?storeId&status&limit&offset|cursor: newest opened first. */
export interface RegisterSessionPage extends ListPageInfo {
  readonly items: RegisterSessionSummary[];
}

/** One session in {@link RegisterSessionPage}. */
export interface RegisterSessionSummary {
  readonly id: string;
  readonly storeId: string;
  readonly registerCode: string;
  readonly status: RegisterSessionStatus;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly openingFloatPaise: number;
  readonly variancePaise: number | null;
}

// Receipt (print) -------------------------------------------------------------

/** GET /payments/:id/receipt: everything a printed receipt or refund slip shows. */
export interface ReceiptView {
  /** "Payment receipt" / "Receipt voucher" / "Refund voucher" / "Refund". */
  readonly title: string;
  readonly number: string;
  readonly voucherNumber: string | null;
  readonly direction: PaymentDirection;
  readonly date: string;
  readonly store: {
    readonly code: string;
    readonly name: string;
    readonly legalName: string | null;
    readonly tradeName: string | null;
    readonly gstin: string | null;
    readonly address: string | null;
  };
  readonly party: {
    readonly id: string;
    readonly name: string;
    readonly phone: string | null;
    readonly gstin: string | null;
  };
  readonly mode: { readonly kind: PaymentModeKind; readonly name: string };
  readonly amountPaise: number;
  readonly amountInWords: string;
  readonly tenderedPaise: number | null;
  readonly changePaise: number | null;
  readonly reference: string | null;
  readonly chequeDate: string | null;
  readonly chequeStatus: ChequeStatus | null;
  /** Live allocations: the bills this money settled. */
  readonly settled: readonly { readonly number: string | null; readonly amountPaise: number }[];
  readonly unallocatedPaise: number;
  /** The party's balance now (positive: they owe). */
  readonly partyBalancePaise: number;
  /** Null when a gateway reported the payment (a payment link). */
  readonly receivedBy: string | null;
  readonly note: string | null;
}

// Tally -----------------------------------------------------------------------

/**
 * A payment received as the Tally export's receipt (spec §6.1; the mapper of
 * ./tally): numbered by its receipt voucher when it has one (an advance),
 * with the bills it still settles. Refunds and bounced cheques are vouchers
 * of their own, not receipts.
 */
export function tallyReceiptOf(
  payment: PaymentView,
  storeCode: string,
  party: TallyParty,
): TallyReceipt {
  return {
    id: payment.id,
    number: payment.voucherNumber ?? payment.number,
    receivedOn: payment.receivedOn,
    storeCode,
    party,
    mode: { kind: payment.mode.kind, name: payment.mode.name },
    amountPaise: payment.amountPaise,
    reference: payment.reference,
    advance: payment.voucherNumber !== null,
    allocations: payment.allocations
      .filter((row) => row.documentId !== null && row.amountPaise > 0 && !row.reversed)
      .map((row) => ({ documentNumber: String(row.targetNumber), amountPaise: row.amountPaise })),
    note: payment.note,
  };
}
