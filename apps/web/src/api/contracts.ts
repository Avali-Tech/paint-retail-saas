import type { ApiClient } from './client.js';
import type { Page } from './page.js';

// Contracts (roadmap P1-M24). Shapes mirror apps/api/src/contracts
// (the API keeps them there, not yet in @paint/shared).

export const CONTRACT_TYPES = [
  'contractor_agreement',
  'supplier_agreement',
  'customer_agreement',
  'dealer_agreement',
  'other',
] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

/** As shown: the stored statuses plus "expired" (active, past its end date in India). */
export const CONTRACT_STATUSES = ['draft', 'active', 'expired', 'terminated', 'renewed'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export interface ContractSummary {
  readonly id: string;
  readonly number: string;
  readonly type: ContractType;
  readonly title: string;
  readonly party: { readonly id: string; readonly name: string; readonly phone: string | null };
  /** Null for a business-wide agreement. */
  readonly store: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly renewalDate: string;
  readonly valuePaise: number | null;
  readonly status: ContractStatus;
  /** Active and its renewal date has come. */
  readonly renewalDue: boolean;
  /** Days left until the end date; negative once it has passed. */
  readonly daysToEnd: number;
  readonly assignedTo: { readonly memberId: string; readonly name: string };
  readonly updatedAt: string;
}

export interface Contract extends ContractSummary {
  readonly project: { readonly id: string; readonly number: string; readonly name: string } | null;
  readonly terms: string | null;
  readonly creditTerms: string | null;
  readonly discountTerms: string | null;
  readonly notes: string | null;
  readonly terminationReason: string | null;
  readonly renewalOf: { readonly id: string; readonly number: string } | null;
  readonly renewedBy: { readonly id: string; readonly number: string } | null;
  readonly createdAt: string;
  readonly endedAt: string | null;
}

export interface ContractQuery {
  readonly q?: string;
  readonly status?: ContractStatus;
  readonly type?: ContractType;
  readonly partyId?: string;
  /** Active contracts ending within this many days (or already ended), soonest first. */
  readonly renewalDue?: number;
  readonly limit?: number;
  readonly offset?: number;
}

/** POST /contracts. Dates are YYYY-MM-DD; money is paise. */
export interface NewContract {
  readonly type: ContractType;
  readonly title: string;
  readonly partyId: string;
  readonly storeId?: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly renewalDate?: string;
  readonly valuePaise?: number;
  readonly terms?: string;
  readonly creditTerms?: string;
  readonly discountTerms?: string;
  readonly notes?: string;
  readonly assignedMemberId?: string;
}

/** PATCH /contracts/:id; null clears a field. Moving a date without renewalDate resets it. */
export interface ContractChange {
  readonly type?: ContractType;
  readonly title?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly renewalDate?: string;
  readonly valuePaise?: number | null;
  readonly terms?: string | null;
  readonly creditTerms?: string | null;
  readonly discountTerms?: string | null;
  readonly notes?: string | null;
  readonly assignedMemberId?: string;
}

/** POST /contracts/:id/renew: the follow-on contract; anything left out is copied. */
export interface Renewal {
  readonly startDate?: string;
  readonly endDate: string;
  readonly renewalDate?: string;
  readonly valuePaise?: number | null;
}

export function contractEndpoints(api: ApiClient) {
  return {
    list: (query: ContractQuery, signal?: AbortSignal) =>
      api.get<Page<ContractSummary>>('/contracts', { query: { ...query }, signal }),
    get: (id: string, signal?: AbortSignal) => api.get<Contract>(`/contracts/${id}`, { signal }),
    create: (input: NewContract) => api.post<Contract>('/contracts', input),
    update: (id: string, change: ContractChange) => api.patch<Contract>(`/contracts/${id}`, change),
    activate: (id: string) => api.post<Contract>(`/contracts/${id}/activate`),
    terminate: (id: string, reason: string) =>
      api.post<Contract>(`/contracts/${id}/terminate`, { reason }),
    /** Answers the new, follow-on contract. */
    renew: (id: string, renewal: Renewal) => api.post<Contract>(`/contracts/${id}/renew`, renewal),
  };
}
