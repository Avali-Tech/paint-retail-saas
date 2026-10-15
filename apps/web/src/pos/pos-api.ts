import type {
  Discount,
  IssuePaymentRequest,
  IssuedInvoiceView,
  LineTintRequest,
  PaymentModeView,
  RegisterSessionSummary,
  TaxDocumentPage,
  TaxDocumentView,
} from '@paint/shared';
import type { ApiClient } from '../api/client.js';
import { ApiError } from '../api/errors.js';

// The counter's calls: drafts and issue (apps/api/src/billing), payment modes and
// register sessions (apps/api/src/payments). Shapes come from @paint/shared
// (tax-documents.ts, billing-api.ts); only the draft body has no shared type yet.

/** POST /invoices and PUT /invoices/:id: a draft, which is also a held bill. */
export interface DraftInput {
  readonly storeId: string;
  readonly partyId?: string;
  readonly buyer: {
    readonly name?: string;
    readonly gstin?: string;
    readonly address?: string;
    readonly stateCode?: string;
  };
  readonly lines: readonly {
    readonly variantId: string;
    readonly quantity: number;
    readonly unitPricePaise: number;
    readonly discount?: Discount;
    readonly tint?: LineTintRequest;
  }[];
}

/** What the counter shows of the register: hidden for a role that may not see sessions. */
export type RegisterState =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'open'; readonly session: RegisterSessionSummary }
  | { readonly kind: 'closed' };

export function posEndpoints(api: ApiClient) {
  return {
    /** Held bills at a store: its drafts, newest first. */
    drafts: (storeId: string, signal?: AbortSignal) =>
      api.get<TaxDocumentPage>('/invoices', {
        query: { storeId, status: 'draft', limit: 50 },
        signal,
      }),
    invoice: (id: string, signal?: AbortSignal) =>
      api.get<TaxDocumentView>(`/invoices/${id}`, { signal }),
    /** The key makes a retried create (a lost answer) return the first draft, not a second one. */
    createDraft: (input: DraftInput, idempotencyKey: string) =>
      api.post<TaxDocumentView>('/invoices', input, {
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    updateDraft: (id: string, input: DraftInput) =>
      api.put<TaxDocumentView>(`/invoices/${id}`, input),
    discardDraft: (id: string) => api.delete<undefined>(`/invoices/${id}`),
    /**
     * Issues the draft and takes its payments in one transaction; `creditOverride`
     * approves leaving money on credit past the rules (MVP 3 spec §4.3).
     */
    issue: (
      id: string,
      payments: readonly IssuePaymentRequest[],
      idempotencyKey: string,
      creditOverride?: { readonly reason: string },
    ) =>
      api.post<IssuedInvoiceView>(
        `/invoices/${id}/issue`,
        {
          ...(payments.length === 0 ? {} : { payments }),
          ...(creditOverride === undefined ? {} : { creditOverride }),
        },
        { headers: { 'Idempotency-Key': idempotencyKey } },
      ),
    /** The active ways to pay. */
    paymentModes: async (signal?: AbortSignal): Promise<PaymentModeView[]> =>
      (await api.get<PaymentModeView[]>('/payment-modes', { signal })).filter(
        (mode) => mode.isActive,
      ),
    /** The store's open register session (register:manage; other roles do not see it). */
    register: async (storeId: string, signal?: AbortSignal): Promise<RegisterState> => {
      try {
        const page = await api.get<{ items: RegisterSessionSummary[] }>('/register-sessions', {
          query: { storeId, status: 'open' },
          signal,
        });
        const [session] = page.items;
        return session ? { kind: 'open', session } : { kind: 'closed' };
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) return { kind: 'hidden' };
        throw error;
      }
    },
  };
}

export type PosEndpoints = ReturnType<typeof posEndpoints>;
