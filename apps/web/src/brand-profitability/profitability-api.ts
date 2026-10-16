import type { BrandProfitabilityView, ProfitabilityGroup } from '@paint/shared';
import type { ApiClient } from '../api/client.js';

// Brand profitability (apps/api/src/brand-profitability). Shapes come from @paint/shared.

export interface ProfitabilityFilters {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly storeId?: string | undefined;
  readonly brandId?: string | undefined;
  readonly groupBy?: ProfitabilityGroup | undefined;
  readonly costOfMoneyBps?: number | undefined;
}

export function brandProfitabilityEndpoints(api: ApiClient) {
  return {
    view: (filters: ProfitabilityFilters, signal?: AbortSignal) =>
      api.get<BrandProfitabilityView>('/reports/brand-profitability', {
        query: { ...filters },
        signal,
      }),
    /** The same figures as CSV, through the reports framework, named by the server. */
    csv: (filters: ProfitabilityFilters) =>
      api.download('/reports/brand-profitability', { query: { ...filters, format: 'csv' } }),
  };
}
