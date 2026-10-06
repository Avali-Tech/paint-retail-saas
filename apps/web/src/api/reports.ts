import type { ApiClient } from './client.js';

// Reports with CSV export (roadmap P1-M22). Shapes mirror apps/api/src/reports.

export interface ReportColumn {
  readonly key: string;
  readonly header: string;
}

/** GET /reports: a report the member may run. */
export interface ReportSummary {
  readonly kind: string;
  readonly title: string;
  readonly columns: readonly ReportColumn[];
  /** The filters it accepts, e.g. storeId, from, to, status. */
  readonly filters: string[];
}

export type ReportValue = string | number | null;

/** GET /reports/:kind: one page of rows. */
export interface ReportPage {
  readonly kind: string;
  readonly title: string;
  readonly columns: readonly ReportColumn[];
  readonly rows: Record<string, ReportValue>[];
  readonly total: number;
}

export type ReportFilters = Readonly<Record<string, string | undefined>>;

export function reportEndpoints(api: ApiClient) {
  return {
    list: (signal?: AbortSignal) => api.get<ReportSummary[]>('/reports', { signal }),
    page: (
      kind: string,
      filters: ReportFilters,
      paging: { limit: number; offset: number },
      signal?: AbortSignal,
    ) => api.get<ReportPage>(`/reports/${kind}`, { query: { ...filters, ...paging }, signal }),
    /** The whole report as CSV (with a BOM for Excel), named by the server. */
    csv: (kind: string, filters: ReportFilters) =>
      api.download(`/reports/${kind}`, { query: { ...filters, format: 'csv' } }),
  };
}
