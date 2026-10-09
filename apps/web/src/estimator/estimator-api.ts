import type {
  ConvertEstimateRequest,
  EstimatePage,
  EstimateRequest,
  EstimateStatus,
  EstimateView,
  ProductPaintFields,
  QuotationView,
} from '@paint/shared';
import type { ApiClient } from '../api/client.js';
import type { Product, ProductType } from '../api/catalog.js';
import type { Page } from '../api/page.js';

// Every call the estimate screens make (round 5a's API, shapes in @paint/shared
// paint-api.ts). Calls that create something carry an idempotency key.

/** A product with its paint fields, as GET /products answers once round 5a is in. */
export type PaintProduct = Product & ProductPaintFields;

export interface EstimateQuery {
  readonly status?: EstimateStatus | undefined;
  readonly q?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface PaintProductQuery {
  readonly q: string;
  readonly type?: ProductType | undefined;
  readonly limit: number;
}

const keyed = (idempotencyKey: string) => ({ headers: { 'Idempotency-Key': idempotencyKey } });

export function estimatorEndpoints(api: ApiClient) {
  return {
    estimates: (query: EstimateQuery, signal?: AbortSignal) =>
      api.get<EstimatePage>('/estimates', { query: { ...query }, signal }),
    estimate: (id: string, signal?: AbortSignal) =>
      api.get<EstimateView>(`/estimates/${id}`, { signal }),
    createEstimate: (input: EstimateRequest, idempotencyKey: string) =>
      api.post<EstimateView>('/estimates', input, keyed(idempotencyKey)),
    /** Draft only: surfaces and options are replaced, which clears computed results. */
    updateEstimate: (id: string, input: EstimateRequest) =>
      api.put<EstimateView>(`/estimates/${id}`, input),
    /** Prices every option and stores the results. */
    computeEstimate: (id: string) => api.post<EstimateView>(`/estimates/${id}/compute`),
    /** A draft quotation from the chosen tier's computed lines. */
    convertEstimate: (id: string, input: ConvertEstimateRequest, idempotencyKey: string) =>
      api.post<QuotationView>(`/estimates/${id}/convert`, input, keyed(idempotencyKey)),

    paintProducts: (query: PaintProductQuery, signal?: AbortSignal) =>
      api.get<Page<PaintProduct>>('/products', { query: { ...query }, signal }),
    paintProduct: (id: string, signal?: AbortSignal) =>
      api.get<PaintProduct>(`/products/${id}`, { signal }),
  };
}

export type EstimatorEndpoints = ReturnType<typeof estimatorEndpoints>;
