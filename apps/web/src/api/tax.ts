import type {
  GstRegistrations,
  GstRegistrationType,
  TaxCategoryOptions,
  TaxCategoryView,
} from '@paint/shared';
import type { ApiClient } from './client.js';

// Settings, Tax & GST. Shapes come from @paint/shared (apps/api/src/tax returns them).

/** The product form's tax categories; Settings, Tax & GST refreshes them after a change. */
export const TAX_OPTIONS_KEY = ['tax-category-options'] as const;

export interface NewTaxCategory {
  readonly name: string;
  readonly rateBps: number;
  readonly effectiveFrom?: string;
}

export interface TaxCategoryChanges {
  readonly name?: string;
  readonly isActive?: boolean;
  readonly isDefault?: true;
}

export interface StoreGstInput {
  readonly registrationType: GstRegistrationType;
  readonly stateCode: string;
  readonly gstin?: string;
  readonly legalName?: string;
  readonly tradeName?: string;
  readonly addressLine?: string;
  readonly city?: string;
  readonly pincode?: string;
}

export function taxEndpoints(api: ApiClient) {
  return {
    categories: (signal?: AbortSignal) => api.get<TaxCategoryView[]>('/tax-categories', { signal }),
    options: (signal?: AbortSignal) =>
      api.get<TaxCategoryOptions>('/tax-categories/options', { signal }),
    createCategory: (input: NewTaxCategory) => api.post<TaxCategoryView>('/tax-categories', input),
    updateCategory: (id: string, changes: TaxCategoryChanges) =>
      api.patch<TaxCategoryView>(`/tax-categories/${id}`, changes),
    addRate: (id: string, input: { rateBps: number; effectiveFrom: string }) =>
      api.post<TaxCategoryView>(`/tax-categories/${id}/rates`, input),
    registrations: (signal?: AbortSignal) =>
      api.get<GstRegistrations>('/gst-registrations', { signal }),
    setBusiness: (legalName: string | null) =>
      api.put<GstRegistrations>('/gst-registrations/business', { legalName }),
    setStore: (storeId: string, input: StoreGstInput) =>
      api.put<GstRegistrations>(`/gst-registrations/stores/${storeId}`, input),
  };
}
