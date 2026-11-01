import type {
  InvoiceAdjustments,
  NoteKind,
  NotePage,
  NoteView,
  PrintBankDetails,
  PrintableInvoiceView,
  ReturnDisposition,
  SalesSettingsView,
  SalesReturnView,
  SlowMoverWindow,
  TaxDocumentPage,
  TaxDocumentStatus,
  TaxDocumentView,
  ValueCreditNoteReason,
} from '@paint/shared';
import type { ApiClient } from './client.js';

// Invoices (read-only here), sales returns and credit / debit notes. Shapes come from
// @paint/shared (apps/api/src/billing returns them).

export interface InvoiceQuery {
  readonly status?: TaxDocumentStatus | undefined;
  readonly q?: string | undefined;
  /** Issue dates, both inclusive. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit: number;
  readonly offset: number;
  /** Where the page starts, from the page before it (round 6c keyset paging). */
  readonly cursor?: string | undefined;
}

export interface NoteQuery {
  readonly kind?: NoteKind | undefined;
  readonly invoiceId?: string | undefined;
  readonly q?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit: number;
  readonly offset: number;
  readonly cursor?: string | undefined;
}

export interface SalesReturnInput {
  readonly invoiceId: string;
  readonly lines: readonly {
    readonly invoiceLineId: string;
    readonly quantity: number;
    readonly disposition: ReturnDisposition;
  }[];
  readonly note?: string;
}

export interface ValueNoteInput {
  readonly invoiceId: string;
  readonly lines: readonly { readonly invoiceLineId: string; readonly valuePaise: number }[];
  readonly valueIncludesTax: boolean;
  readonly note?: string;
}

export interface CreditNoteInput extends ValueNoteInput {
  readonly reason: ValueCreditNoteReason;
  readonly schemeReference?: string;
}

/** PUT /sales/settings: what the invoice print settings send (other fields are left as they are). */
export interface InvoicePrintSettingsInput {
  readonly invoiceBank: PrintBankDetails | null;
  readonly invoiceTerms: readonly string[];
}

/** PUT /sales/settings: the tinting machine's units, in ml; null clears one. */
export interface TintSettingsInput {
  readonly tintShotMl: number | null;
  readonly tintYMl: number | null;
}

/** PUT /sales/settings: days idle before stock is announced as slow; null: no alert. */
export interface StockAlertSettingsInput {
  readonly slowMoverAlertDays: SlowMoverWindow | null;
  /** What bringing stock from another store costs, paise; null: not set. */
  readonly storeDeliveryCostPaise: number | null;
}

export function salesEndpoints(api: ApiClient) {
  return {
    /** GET /sales/settings (organization:manage). */
    settings: (signal?: AbortSignal) => api.get<SalesSettingsView>('/sales/settings', { signal }),
    saveSettings: (
      input: InvoicePrintSettingsInput | TintSettingsInput | StockAlertSettingsInput,
    ) => api.put<SalesSettingsView>('/sales/settings', input),
    /** Tax invoices and bills of supply only: notes have their own list. */
    invoices: (query: InvoiceQuery, signal?: AbortSignal) =>
      api.get<TaxDocumentPage>('/invoices', {
        query: { ...query, kinds: 'invoice,bill_of_supply' },
        signal,
      }),
    invoice: (id: string, signal?: AbortSignal) =>
      api.get<TaxDocumentView>(`/invoices/${id}`, { signal }),
    /** An issued invoice with its print settings, to reprint it. */
    printable: (id: string, signal?: AbortSignal) =>
      api.get<PrintableInvoiceView>(`/invoices/${id}/print`, { signal }),
    /** The issued invoice as an A4 PDF, its labels also in Hindi or Telugu. */
    invoicePdf: (id: string, lang: 'en' | 'hi' | 'te') =>
      api.download(`/invoices/${id}/invoice.pdf`, { query: { lang } }),
    /** Same-day cancellation of an issued invoice (billing:cancel). */
    cancelInvoice: (id: string, reason: string) =>
      api.post<TaxDocumentView>(`/invoices/${id}/cancel`, { reason }),
    adjustments: (id: string, signal?: AbortSignal) =>
      api.get<InvoiceAdjustments>(`/invoices/${id}/adjustments`, { signal }),
    returnGoods: (input: SalesReturnInput) => api.post<SalesReturnView>('/sales-returns', input),
    creditNote: (input: CreditNoteInput) => api.post<NoteView>('/credit-notes', input),
    debitNote: (input: ValueNoteInput) => api.post<NoteView>('/debit-notes', input),
    notes: (query: NoteQuery, signal?: AbortSignal) =>
      api.get<NotePage>('/notes', { query: { ...query }, signal }),
    note: (id: string, signal?: AbortSignal) => api.get<NoteView>(`/notes/${id}`, { signal }),
  };
}
