import type { CreditCheck, CreditRules } from '@paint/shared';
import type { ApiClient } from './client.js';
import type { Page } from './parties.js';

// Credit profiles, requests and rules. Shapes mirror apps/api/src/credit.

export type CreditStatus = 'none' | 'active' | 'on_hold';
export type CreditRisk = 'low' | 'medium' | 'high';
export const CREDIT_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type CreditRequestStatus = (typeof CREDIT_REQUEST_STATUSES)[number];

/** A party's credit as the customer 360 shows it. */
export interface CreditSummary {
  readonly status: CreditStatus;
  readonly limitPaise: number;
  readonly creditDays: number;
  readonly risk: CreditRisk;
  /** What the party owes, entered by hand until billing exists. */
  readonly manualExposurePaise: number;
  readonly overdueDays: number;
  readonly check: CreditCheck;
  readonly pendingRequest: {
    readonly id: string;
    readonly number: string;
    readonly limitPaise: number;
    readonly creditDays: number;
  } | null;
}

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
    release: (partyId: string) => api.post<unknown>(`/parties/${partyId}/credit/release`),
    rules: (signal?: AbortSignal) => api.get<CreditRules>('/credit-rules', { signal }),
    setRules: (rules: CreditRules) => api.put<CreditRules>('/credit-rules', rules),
  };
}
