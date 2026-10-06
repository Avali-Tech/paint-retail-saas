import type { ApiClient } from './client.js';
import type { Page } from './page.js';

// Leads and opportunities. Shapes mirror apps/api/src/leads (not yet in @paint/shared).

export const LEAD_SOURCES = [
  'walk_in',
  'phone_call',
  'referral',
  'architect',
  'contractor',
  'painter',
  'website',
  'social_media',
  'exhibition',
  'other',
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_STAGES = ['new', 'contacted', 'qualified', 'opportunity', 'won', 'lost'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/** Stages a lead is moved between by hand; the rest come from converting, winning or losing. */
export const OPEN_LEAD_STAGES = ['new', 'contacted', 'qualified'] as const;
export type OpenLeadStage = (typeof OPEN_LEAD_STAGES)[number];

export const OPPORTUNITY_STAGES = ['discovery', 'proposal', 'negotiation', 'won', 'lost'] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export const OPEN_OPPORTUNITY_STAGES = ['discovery', 'proposal', 'negotiation'] as const;
export type OpenOpportunityStage = (typeof OPEN_OPPORTUNITY_STAGES)[number];

interface StoreRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

interface PartyRef {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
}

export interface Person {
  readonly memberId: string;
  readonly name: string;
}

export interface Lead {
  readonly id: string;
  readonly number: string;
  readonly store: StoreRef;
  readonly party: PartyRef;
  readonly title: string;
  readonly requirement: string | null;
  readonly source: LeadSource;
  readonly referredBy: { readonly id: string; readonly name: string } | null;
  readonly estimatedValuePaise: number | null;
  readonly expectedOrderDate: string | null;
  readonly assignedTo: Person;
  readonly stage: LeadStage;
  readonly lostReason: string | null;
  readonly opportunityId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface StageTotal {
  readonly stage: string;
  readonly count: number;
  readonly valuePaise: number;
}

/** POST /leads: an existing party or a quick contact (matched by mobile, else added as a customer). */
export interface LeadInput {
  readonly storeId: string;
  readonly partyId?: string;
  readonly contact?: { readonly displayName: string; readonly phone: string };
  readonly title: string;
  readonly requirement?: string;
  readonly source: LeadSource;
  readonly estimatedValuePaise?: number;
  readonly expectedOrderDate?: string;
  readonly assignedMemberId?: string;
}

/** PATCH /leads/:id (null clears a field). */
export interface LeadChanges {
  readonly title?: string;
  readonly requirement?: string | null;
  readonly source?: LeadSource;
  readonly estimatedValuePaise?: number | null;
  readonly expectedOrderDate?: string | null;
}

export interface CrmQuery {
  readonly q?: string | undefined;
  readonly storeId?: string | undefined;
  /** One party's records, e.g. for the customer 360's "see all". */
  readonly partyId?: string | undefined;
  /** A member id, or "me". */
  readonly assignedTo?: string | undefined;
  readonly limit?: number;
  readonly offset?: number;
}

export interface LeadQuery extends CrmQuery {
  readonly stage?: LeadStage | undefined;
  readonly source?: LeadSource | undefined;
}

export interface Opportunity {
  readonly id: string;
  readonly number: string;
  readonly store: StoreRef;
  readonly party: PartyRef;
  readonly lead: { readonly id: string; readonly number: string } | null;
  readonly project: { readonly id: string; readonly number: string } | null;
  readonly title: string;
  readonly expectedValuePaise: number;
  readonly weightedValuePaise: number;
  readonly expectedQuantity: number | null;
  readonly expectedOrderDate: string | null;
  readonly category: { readonly id: string; readonly name: string } | null;
  readonly salesperson: Person;
  readonly probability: number;
  readonly stage: OpportunityStage;
  readonly lostReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface OpportunityStageTotal extends StageTotal {
  readonly weightedValuePaise: number;
}

/** POST /leads/:id/convert. */
export interface ConvertInput {
  readonly title?: string;
  readonly expectedValuePaise: number;
  readonly expectedOrderDate?: string;
  readonly probability?: number;
}

/** PATCH /opportunities/:id. */
export interface OpportunityChanges {
  readonly title?: string;
  readonly expectedValuePaise?: number;
  readonly expectedOrderDate?: string | null;
  readonly probability?: number;
}

export interface OpportunityQuery extends CrmQuery {
  readonly stage?: OpportunityStage | undefined;
}

export function leadEndpoints(api: ApiClient) {
  return {
    list: (query: LeadQuery, signal?: AbortSignal) =>
      api.get<Page<Lead>>('/leads', { query: { ...query }, signal }),
    pipeline: (query: CrmQuery, signal?: AbortSignal) =>
      api.get<StageTotal[]>('/leads/pipeline', { query: { ...query }, signal }),
    get: (id: string, signal?: AbortSignal) => api.get<Lead>(`/leads/${id}`, { signal }),
    create: (input: LeadInput) => api.post<Lead>('/leads', input),
    update: (id: string, changes: LeadChanges) => api.patch<Lead>(`/leads/${id}`, changes),
    assign: (id: string, memberId: string) => api.post<Lead>(`/leads/${id}/assign`, { memberId }),
    moveTo: (id: string, stage: OpenLeadStage) => api.post<Lead>(`/leads/${id}/stage`, { stage }),
    lose: (id: string, reason: string) => api.post<Lead>(`/leads/${id}/lose`, { reason }),
    win: (id: string) => api.post<Lead>(`/leads/${id}/win`),
    reopen: (id: string) => api.post<Lead>(`/leads/${id}/reopen`),
    convert: (id: string, input: ConvertInput) =>
      api.post<Opportunity>(`/leads/${id}/convert`, input),
  };
}

export function opportunityEndpoints(api: ApiClient) {
  return {
    list: (query: OpportunityQuery, signal?: AbortSignal) =>
      api.get<Page<Opportunity>>('/opportunities', { query: { ...query }, signal }),
    pipeline: (query: CrmQuery, signal?: AbortSignal) =>
      api.get<OpportunityStageTotal[]>('/opportunities/pipeline', { query: { ...query }, signal }),
    get: (id: string, signal?: AbortSignal) =>
      api.get<Opportunity>(`/opportunities/${id}`, { signal }),
    update: (id: string, changes: OpportunityChanges) =>
      api.patch<Opportunity>(`/opportunities/${id}`, changes),
    assign: (id: string, memberId: string) =>
      api.post<Opportunity>(`/opportunities/${id}/assign`, { memberId }),
    moveTo: (id: string, stage: OpenOpportunityStage) =>
      api.post<Opportunity>(`/opportunities/${id}/stage`, { stage }),
    win: (id: string) => api.post<Opportunity>(`/opportunities/${id}/win`),
    lose: (id: string, reason: string) =>
      api.post<Opportunity>(`/opportunities/${id}/lose`, { reason }),
  };
}
