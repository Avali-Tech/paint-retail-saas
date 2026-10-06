import type { ApiClient } from './client.js';

// Reports with CSV export (roadmap P1-M22). Shapes mirror apps/api/src/reports.

export interface ReportColumn {
  /** "<kind>.<key>", stable across releases: headers are translated by it. */
  readonly id: string;
  readonly key: string;
  /** The API's English header, shown when the app has no translation. */
  readonly header: string;
}

/** What input a filter takes (see apps/api/src/reports/report-filters.ts). */
export type ReportFilterType = 'store' | 'date' | 'enum' | 'supplier' | 'boolean';

export interface ReportFilter {
  /** The query parameter, e.g. "storeId". */
  readonly name: string;
  readonly type: ReportFilterType;
  /** The values an enum filter accepts, in display order. */
  readonly values?: readonly string[];
  /** What applies when left out ("true"/"false" for a boolean). */
  readonly default?: string;
}

/** GET /reports: a report the member may run. */
export interface ReportSummary {
  readonly kind: string;
  readonly title: string;
  readonly columns: readonly ReportColumn[];
  /** The filters it accepts, with their type and allowed values. */
  readonly filters: readonly ReportFilter[];
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
