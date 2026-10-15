import type {
  AgeingGroup,
  AgeingPage,
  PrintLanguage,
  ReceivablesSummaryView,
  StatementData,
} from '@paint/shared';
import type { ApiClient } from '../api/client.js';

// Receivables and statements (apps/api/src/receivables, apps/api/src/statements).
// Shapes come from @paint/shared (receivables/api.ts).

/** Filters every receivables figure takes. */
export interface ReceivablesFilters {
  readonly asOf?: string | undefined;
  readonly storeId?: string | undefined;
  /** A member's id, or "none". */
  readonly salespersonId?: string | undefined;
}

export interface AgeingFilters extends ReceivablesFilters {
  readonly groupBy: AgeingGroup;
  readonly q?: string | undefined;
  readonly overdueOnly?: boolean | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface StatementPeriod {
  readonly from: string;
  readonly to: string;
}

export function receivablesEndpoints(api: ApiClient) {
  return {
    summary: (filters: ReceivablesFilters, signal?: AbortSignal) =>
      api.get<ReceivablesSummaryView>('/receivables/summary', { query: { ...filters }, signal }),
    ageing: (filters: AgeingFilters, signal?: AbortSignal) =>
      api.get<AgeingPage>('/receivables/ageing', { query: { ...filters }, signal }),
    /** The ageing as CSV, through the reports framework, named by the server. */
    ageingCsv: (
      filters: Omit<ReceivablesFilters, 'salespersonId'> & { readonly groupBy: AgeingGroup },
    ) => api.download('/reports/receivables-ageing', { query: { ...filters, format: 'csv' } }),
    statement: (partyId: string, period: StatementPeriod, signal?: AbortSignal) =>
      api.get<StatementData>(`/parties/${partyId}/statement`, { query: { ...period }, signal }),
    /** The statement as an A4 PDF, labelled in English and `lang`. */
    statementPdf: (partyId: string, period: StatementPeriod, lang: PrintLanguage) =>
      api.download(`/parties/${partyId}/statement.pdf`, { query: { ...period, lang } }),
  };
}
