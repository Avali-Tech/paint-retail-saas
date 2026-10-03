import type { ApiClient } from './client.js';
import type { Page } from './page.js';

// Physical stock counts. Shapes mirror apps/api/src/stock-counts.

export const COUNT_STATUSES = ['counting', 'submitted', 'approved', 'cancelled'] as const;
export type CountStatus = (typeof COUNT_STATUSES)[number];

export const COUNT_SCOPES = ['full', 'brand', 'category'] as const;
export type CountScope = (typeof COUNT_SCOPES)[number];

export const VARIANCE_REASONS = ['damage', 'theft', 'expiry', 'counting_error', 'other'] as const;
export type VarianceReason = (typeof VARIANCE_REASONS)[number];

export interface CountLine {
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly brandName: string;
  readonly expectedQuantity: number;
  readonly countedQuantity: number | null;
  /** counted - expected; null until counted. */
  readonly variance: number | null;
  /** variance × the store's average cost, in paise; null without a cost. */
  readonly varianceValuePaise: number | null;
  readonly reason: VarianceReason | null;
}

export interface CountSummary {
  readonly totalLines: number;
  readonly countedLines: number;
  readonly uncountedLines: number;
  readonly matchingLines: number;
  /** Share of counted products whose count matched the books; null before any count. */
  readonly accuracyPercent: number | null;
  readonly netVarianceValuePaise: number;
  readonly absoluteVarianceValuePaise: number;
}

export interface StockCount {
  readonly id: string;
  readonly number: string;
  readonly status: CountStatus;
  readonly store: { readonly id: string; readonly code: string; readonly name: string };
  readonly scope: CountScope;
  readonly scopeId: string | null;
  readonly note: string | null;
  readonly closingReason: string | null;
  readonly startedAt: string;
  readonly submittedAt: string | null;
  readonly approvedAt: string | null;
  readonly closedAt: string | null;
  readonly summary: CountSummary;
  readonly lines: CountLine[];
}

export interface CountListItem {
  readonly id: string;
  readonly number: string;
  readonly status: CountStatus;
  readonly store: { readonly id: string; readonly code: string };
  readonly scope: CountScope;
  readonly startedAt: string;
}

export interface StoreAccuracy {
  readonly store: { readonly id: string; readonly code: string; readonly name: string };
  readonly lastCount: {
    readonly number: string;
    readonly approvedAt: string;
    readonly accuracyPercent: number | null;
    readonly countedLines: number;
  } | null;
}

/** A counted quantity for one product, by id or by a scanned barcode / typed SKU. */
export type CountEntry = (
  | { readonly variantId: string; readonly code?: never }
  | { readonly code: string; readonly variantId?: never }
) & {
  /** "add" (a scan adds 1) or "set" (replaces what is counted). */
  readonly mode?: 'add' | 'set';
  readonly quantity?: number;
};

export interface CountQuery {
  readonly storeId?: string;
  readonly status?: CountStatus;
  readonly limit?: number;
  readonly offset?: number;
}

export function stockCountEndpoints(api: ApiClient) {
  return {
    list: (query: CountQuery, signal?: AbortSignal) =>
      api.get<Page<CountListItem>>('/stock-counts', { query: { ...query }, signal }),
    accuracy: (signal?: AbortSignal) =>
      api.get<StoreAccuracy[]>('/stock-counts/accuracy', { signal }),
    get: (id: string, signal?: AbortSignal) =>
      api.get<StockCount>(`/stock-counts/${id}`, { signal }),
    start: (input: { storeId: string; scope: CountScope; scopeId?: string; note?: string }) =>
      api.post<StockCount>('/stock-counts', input),
    record: (id: string, entries: CountEntry[]) =>
      api.post<StockCount>(`/stock-counts/${id}/counts`, { entries }),
    submit: (id: string, uncountedAsZero: boolean) =>
      api.post<StockCount>(`/stock-counts/${id}/submit`, { uncountedAsZero }),
    reopen: (id: string) => api.post<StockCount>(`/stock-counts/${id}/reopen`),
    approve: (id: string, reasons: { variantId: string; reason: VarianceReason }[]) =>
      api.post<StockCount>(`/stock-counts/${id}/approve`, { reasons }),
    cancel: (id: string, reason: string) =>
      api.post<StockCount>(`/stock-counts/${id}/cancel`, { reason }),
  };
}
