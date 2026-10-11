import type {
  InvoiceAdjustments,
  NoteKind,
  NotePage,
  NoteView,
  PrintBankDetails,
  ReturnDisposition,
  SalesSettingsView,
  SalesReturnView,
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

export function salesEndpoints(api: ApiClient) {
  return {
    /** GET /sales/settings (organization:manage). */
    settings: (signal?: AbortSignal) => api.get<SalesSettingsView>('/sales/settings', { signal }),
    saveSettings: (input: InvoicePrintSettingsInput) =>
      api.put<SalesSettingsView>('/sales/settings', input),
    /** Tax invoices and bills of supply only: notes have their own list. */
    invoices: (query: InvoiceQuery, signal?: AbortSignal) =>
      api.get<TaxDocumentPage>('/invoices', {
        query: { ...query, kinds: 'invoice,bill_of_supply' },
        signal,
      }),
    invoice: (id: string, signal?: AbortSignal) =>
      api.get<TaxDocumentView>(`/invoices/${id}`, { signal }),
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
