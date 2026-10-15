import type {
  ApproveCreditRequest,
  CreateCreditApprovalRequest,
  CreateSiteAccountRequest,
  CreditApprovalDetail,
  CreditApprovalKind,
  CreditApprovalPage,
  CreditApprovalStatus,
  CreditApprovalView,
  CreditRules,
  PartyCreditSummary,
  ReleaseCreditRequest,
  SiteAccountDetail,
  SiteAccountView,
  UpdateSiteAccountRequest,
} from '@paint/shared';
import type { ApiClient } from './client.js';
import type { Page } from './parties.js';

// Credit profiles, requests and rules. Shapes mirror apps/api/src/credit.

export type CreditStatus = 'none' | 'active' | 'on_hold';
export type CreditRisk = 'low' | 'medium' | 'high';
export const CREDIT_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type CreditRequestStatus = (typeof CREDIT_REQUEST_STATUSES)[number];

/**
 * A party's credit as the customer 360 shows it (MVP 3): live exposure after
 * go-live, holds, the waiver, a release waiting and its site accounts.
 */
export type CreditSummary = PartyCreditSummary;

interface Person {
  readonly memberId: string;
  readonly name: string;
}

export interface CreditRequest {
  readonly id: string;
  readonly number: string;
  readonly party: { readonly id: string; readonly name: string };
  readonly limitPaise: number;
  readonly creditDays: number;
  readonly previousLimitPaise: number;
  readonly previousCreditDays: number;
  readonly note: string | null;
  readonly status: CreditRequestStatus;
  readonly requestedBy: Person;
  readonly createdAt: string;
  readonly decidedBy: Person | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
}

export interface CreditRequestInput {
  readonly partyId: string;
  readonly limitPaise: number;
  readonly creditDays: number;
  readonly note?: string;
}

/** PATCH /parties/:id/credit: risk, and what the party owes and how late (by hand until billing). */
export interface CreditUpdate {
  readonly risk: CreditRisk;
  readonly manualExposurePaise: number;
  readonly overdueDays: number;
}

export const CREDIT_RISKS = ['low', 'medium', 'high'] as const satisfies readonly CreditRisk[];

export interface CreditRequestQuery {
  readonly status?: CreditRequestStatus;
  readonly limit?: number;
  readonly offset?: number;
}

/** GET /credit-approvals: `mine` keeps to those the member may decide. */
export interface CreditApprovalQuery {
  readonly status?: CreditApprovalStatus;
  readonly kind?: CreditApprovalKind;
  readonly partyId?: string;
  readonly mine: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export function creditEndpoints(api: ApiClient) {
  return {
    request: (input: CreditRequestInput) => api.post<CreditRequest>('/credit-requests', input),
    requests: (query: CreditRequestQuery, signal?: AbortSignal) =>
      api.get<Page<CreditRequest>>('/credit-requests', { query: { ...query }, signal }),
    getRequest: (id: string, signal?: AbortSignal) =>
      api.get<CreditRequest>(`/credit-requests/${id}`, { signal }),
    approve: (requestId: string, note?: string) =>
      api.post<CreditRequest>(`/credit-requests/${requestId}/approve`, { note }),
    reject: (requestId: string, reason: string) =>
      api.post<CreditRequest>(`/credit-requests/${requestId}/reject`, { reason }),
    update: (partyId: string, input: CreditUpdate) =>
      api.patch<unknown>(`/parties/${partyId}/credit`, input),
    hold: (partyId: string, reason: string) =>
      api.post<unknown>(`/parties/${partyId}/credit/hold`, { reason }),
    release: (partyId: string, input: ReleaseCreditRequest = {}) =>
      api.post<unknown>(`/parties/${partyId}/credit/release`, input),
    rules: (signal?: AbortSignal) => api.get<CreditRules>('/credit-rules', { signal }),
    setRules: (rules: CreditRules) => api.put<CreditRules>('/credit-rules', rules),
    // Approvals of sales past the rules and of releases (MVP 3 spec §4.3).
    approvals: (query: CreditApprovalQuery, signal?: AbortSignal) =>
      api.get<CreditApprovalPage>('/credit-approvals', {
        query: { ...query, mine: String(query.mine) },
        signal,
      }),
    approval: (id: string, signal?: AbortSignal) =>
      api.get<CreditApprovalDetail>(`/credit-approvals/${id}`, { signal }),
    askApproval: (input: CreateCreditApprovalRequest) =>
      api.post<CreditApprovalView>('/credit-approvals', input),
    approveApproval: (id: string, input: ApproveCreditRequest) =>
      api.post<CreditApprovalView>(`/credit-approvals/${id}/approve`, input),
    rejectApproval: (id: string, reason: string) =>
      api.post<CreditApprovalView>(`/credit-approvals/${id}/reject`, { reason }),
    cancelApproval: (id: string) => api.post<CreditApprovalView>(`/credit-approvals/${id}/cancel`),
    // Site accounts under a contractor (MVP 3 spec §3.3).
    addSite: (partyId: string, input: CreateSiteAccountRequest) =>
      api.post<SiteAccountView>(`/parties/${partyId}/sites`, input),
    site: (id: string, signal?: AbortSignal) =>
      api.get<SiteAccountDetail>(`/site-accounts/${id}`, { signal }),
    updateSite: (id: string, input: UpdateSiteAccountRequest) =>
      api.patch<SiteAccountView>(`/site-accounts/${id}`, input),
    holdSite: (id: string, reason: string) =>
      api.post<SiteAccountView>(`/site-accounts/${id}/hold`, { reason }),
    releaseSite: (id: string) => api.post<SiteAccountView>(`/site-accounts/${id}/release`),
    closeSite: (id: string) => api.post<SiteAccountView>(`/site-accounts/${id}/close`),
  };
}
