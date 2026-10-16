import type {
  BenefitReceiptInput,
  BenefitReceiptView,
  BrandClaimStatus,
  BrandClaimView,
  PriceHikePlanInput,
  PriceHikePlanView,
  SchemeClaimsReport,
  SchemeDetail,
  SchemeInput,
  SchemeStatus,
  SchemeSummary,
  SchemesOverview,
  SchemeView,
} from '@paint/shared';
import type { ApiClient } from '../api/client.js';

// Brand schemes, targets and rebates (apps/api/src/brand-schemes, P2-M33). Shapes come
// from @paint/shared.

export interface SchemeFilters {
  readonly status?: SchemeStatus | undefined;
  readonly brandId?: string | undefined;
}

export interface ClaimFiling {
  readonly filedOn: string;
  /** Left out: what the scheme still has owed on that day. */
  readonly claimedPaise?: number;
  readonly brandReference: string | null;
  readonly note: string | null;
}

export interface ClaimUpdate {
  readonly status: Exclude<BrandClaimStatus, 'filed'>;
  readonly brandReference: string | null;
  readonly note: string | null;
}

export function schemeEndpoints(api: ApiClient) {
  return {
    list: (filters: SchemeFilters, signal?: AbortSignal) =>
      api.get<SchemeSummary[]>('/brand-schemes', { query: { ...filters }, signal }),
    overview: (signal?: AbortSignal) =>
      api.get<SchemesOverview>('/brand-schemes/overview', { signal }),
    claims: (signal?: AbortSignal) =>
      api.get<SchemeClaimsReport>('/brand-schemes/claims', { signal }),
    detail: (id: string, signal?: AbortSignal) =>
      api.get<SchemeDetail>(`/brand-schemes/${id}`, { signal }),
    create: (body: SchemeInput) => api.post<SchemeView>('/brand-schemes', body),
    update: (id: string, body: SchemeInput) => api.put<SchemeView>(`/brand-schemes/${id}`, body),
    activate: (id: string) => api.post<SchemeView>(`/brand-schemes/${id}/activate`),
    close: (id: string, note: string | null) =>
      api.post<SchemeView>(`/brand-schemes/${id}/close`, { note }),
    cancel: (id: string, note: string | null) =>
      api.post<SchemeView>(`/brand-schemes/${id}/cancel`, { note }),
    /** One entry per key: a retried click never records a credit note twice. */
    recordReceipt: (id: string, body: BenefitReceiptInput, idempotencyKey: string) =>
      api.post<BenefitReceiptView>(`/brand-schemes/${id}/receipts`, body, {
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    fileClaim: (id: string, body: ClaimFiling) =>
      api.post<BrandClaimView>(`/brand-schemes/${id}/claims`, body),
    updateClaim: (claimId: string, body: ClaimUpdate) =>
      api.post<BrandClaimView>(`/brand-schemes/claims/${claimId}/status`, body),
    plan: (body: PriceHikePlanInput) =>
      api.post<PriceHikePlanView>('/brand-schemes/price-hike-plan', body),
    /** The schemes or their claims as CSV, through the reports framework. */
    csv: (kind: 'brand-schemes' | 'brand-scheme-claims') =>
      api.download(`/reports/${kind}`, { query: { format: 'csv' } }),
  };
}
