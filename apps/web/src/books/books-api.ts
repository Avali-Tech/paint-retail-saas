import type {
  AccountingExportPage,
  AccountingExportPreview,
  AccountingExportQuery,
  AccountingExportRequest,
  CashMovementRequest,
  CloseRegisterRequest,
  LatestReconciliation,
  LedgerMappingRequest,
  LedgerMappingView,
  OpenRegisterRequest,
  PaymentDirection,
  PaymentModeKind,
  PaymentModeView,
  PaymentPage,
  ReconciliationRunView,
  RegisterSessionPage,
  RegisterSessionStatus,
  RegisterSessionView,
} from '@paint/shared';
import type { ApiClient } from '../api/client.js';

// The day end and the books: register sessions and payments (apps/api/src/payments),
// ledger mappings and the Tally export (apps/api/src/accounting), and the nightly
// reconciliation (apps/api/src/reconciliation). Shapes come from
// @paint/shared (billing-api.ts, accounting-api.ts).

export interface RegisterQuery {
  readonly storeId: string;
  readonly status?: RegisterSessionStatus | undefined;
  readonly limit: number;
  readonly offset: number;
  /** Where the page starts, from the page before it (round 6c keyset paging). */
  readonly cursor?: string | undefined;
}

export interface PaymentQuery {
  readonly direction?: PaymentDirection | undefined;
  /** One way of paying, e.g. `upi_link` for what payment links brought in. */
  readonly modeKind?: PaymentModeKind | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly q?: string | undefined;
  readonly limit: number;
  readonly offset: number;
  /** Where the page starts, from the page before it (round 6c keyset paging). */
  readonly cursor?: string | undefined;
}

export function booksEndpoints(api: ApiClient) {
  return {
    registers: (query: RegisterQuery, signal?: AbortSignal) =>
      api.get<RegisterSessionPage>('/register-sessions', {
        query: { ...query },
        signal,
      }),
    register: (id: string, signal?: AbortSignal) =>
      api.get<RegisterSessionView>(`/register-sessions/${id}`, { signal }),
    openRegister: (code: string, input: OpenRegisterRequest) =>
      api.post<RegisterSessionView>(`/registers/${encodeURIComponent(code)}/open`, input),
    moveCash: (id: string, input: CashMovementRequest) =>
      api.post<RegisterSessionView>(`/register-sessions/${id}/movements`, input),
    closeRegister: (id: string, input: CloseRegisterRequest) =>
      api.post<RegisterSessionView>(`/register-sessions/${id}/close`, input),
    payments: (query: PaymentQuery, signal?: AbortSignal) =>
      api.get<PaymentPage>('/payments', { query: { ...query }, signal }),
    /** The receipt or refund slip as a PDF. */
    receiptPdf: (id: string) => api.download(`/payments/${id}/receipt.pdf`),
    /** Every payment mode, in use or not: mappings may name either. */
    paymentModes: (signal?: AbortSignal) =>
      api.get<PaymentModeView[]>('/payment-modes', { signal }),
    mappings: (signal?: AbortSignal) =>
      api.get<LedgerMappingView[]>('/ledger-mappings', { signal }),
    createMapping: (input: LedgerMappingRequest) =>
      api.post<LedgerMappingView>('/ledger-mappings', input),
    updateMapping: (id: string, input: LedgerMappingRequest) =>
      api.put<LedgerMappingView>(`/ledger-mappings/${id}`, input),
    deleteMapping: (id: string) => api.delete<undefined>(`/ledger-mappings/${id}`),
    exportPreview: (query: AccountingExportQuery, signal?: AbortSignal) =>
      api.get<AccountingExportPreview>('/accounting-exports/preview', {
        query: { from: query.from, to: query.to, kinds: query.kinds.join(',') },
        signal,
      }),
    exports: (offset: number, limit: number, signal?: AbortSignal) =>
      api.get<AccountingExportPage>('/accounting-exports', { query: { offset, limit }, signal }),
    /** Records the export and answers its file. */
    exportFile: (input: AccountingExportRequest) =>
      api.download('/accounting-exports', { body: input }),
    /** The newest reconciliation of the books, with what it found (null before the first). */
    latestReconciliation: (signal?: AbortSignal) =>
      api.get<LatestReconciliation>('/reconciliation/latest', { signal }),
    /** Reconciles the books now and answers what it found. */
    runReconciliation: () => api.post<ReconciliationRunView>('/reconciliation/runs', {}),
  };
}

export type BooksEndpoints = ReturnType<typeof booksEndpoints>;
