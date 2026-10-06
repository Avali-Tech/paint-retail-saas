import type { ApiClient } from './client.js';
import type { CreditSummary } from './credit.js';
import type { LoyaltySummary } from './loyalty.js';

// Customers and other parties, and the customer 360. Shapes mirror
// apps/api/src/parties (the API keeps them there, not yet in @paint/shared).

export const PARTY_ROLES = [
  'customer',
  'contractor',
  'painter',
  'architect',
  'dealer',
  'supplier',
  'distributor',
  'sub_dealer',
] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

export const CUSTOMER_TYPES = [
  'retail',
  'contractor',
  'painter',
  'dealer',
  'builder',
  'corporate',
] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export const CONTACT_METHODS = ['phone', 'whatsapp', 'email', 'visit'] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];

export interface Party {
  readonly id: string;
  readonly kind: 'person' | 'organization';
  readonly displayName: string;
  readonly legalName: string | null;
  readonly contactPerson: string | null;
  readonly phone: string | null;
  readonly alternatePhone: string | null;
  readonly email: string | null;
  readonly gstin: string | null;
  readonly pan: string | null;
  readonly addressLine: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly pincode: string | null;
  readonly homeStoreId: string | null;
  readonly notes: string | null;
  readonly tags: string[];
  readonly isActive: boolean;
  /** Set when this party was merged into another: open that one instead. */
  readonly mergedIntoId: string | null;
  readonly roles: PartyRole[];
  readonly customer: {
    readonly customerType: CustomerType;
    readonly assignedMemberId: string | null;
    readonly preferredContact: ContactMethod;
  } | null;
}

export interface Page<T> {
  readonly items: T[];
  readonly total: number;
}

/** The body of POST /parties and PATCH /parties/:id (null clears a field on PATCH). */
export interface PartyInput {
  readonly kind: 'person' | 'organization';
  readonly displayName: string;
  readonly legalName?: string | null;
  readonly contactPerson?: string | null;
  readonly phone?: string | null;
  readonly alternatePhone?: string | null;
  readonly email?: string | null;
  readonly gstin?: string | null;
  readonly pan?: string | null;
  readonly addressLine?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly pincode?: string | null;
  readonly homeStoreId?: string | null;
  readonly notes?: string | null;
  readonly tags: string[];
  readonly roles: PartyRole[];
  readonly customer?: { customerType?: CustomerType; preferredContact?: ContactMethod };
}

export interface PartyQuery {
  readonly q?: string;
  readonly role?: PartyRole;
  readonly includeInactive?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

interface Section<T> {
  readonly total: number;
  readonly items: T[];
}

/** GET /parties/:id/overview: the customer 360. Sections the member cannot see are null. */
export interface PartyOverview {
  readonly party: Party;
  readonly leads:
    | (Section<{
        id: string;
        number: string;
        title: string;
        stage: string;
        storeCode: string;
        estimatedValuePaise: number | null;
        updatedAt: string;
      }> & { readonly open: number })
    | null;
  readonly opportunities:
    | (Section<{
        id: string;
        number: string;
        title: string;
        stage: string;
        storeCode: string;
        expectedValuePaise: number;
        probability: number;
        updatedAt: string;
      }> & { readonly openValuePaise: number; readonly wonValuePaise: number })
    | null;
  readonly projects: Section<{
    id: string;
    number: string;
    name: string;
    stage: string;
    storeCode: string;
    city: string | null;
    roles: string[];
    updatedAt: string;
  }> | null;
  readonly contracts:
    | (Section<{
        id: string;
        number: string;
        title: string;
        type: string;
        status: string;
        startDate: string;
        endDate: string;
        renewalDate: string;
        renewalDue: boolean;
        valuePaise: number | null;
      }> & { readonly active: number; readonly renewalDue: number })
    | null;
  readonly credit: CreditSummary | null;
  readonly loyalty: LoyaltySummary | null;
  readonly activities: Section<{
    id: string;
    type: string;
    subject: string;
    status: 'scheduled' | 'done' | 'cancelled';
    record: { type: string; id: string; label: string };
    at: string;
  }> & {
    readonly nextFollowUp: { id: string; subject: string; dueAt: string; label: string } | null;
  };
  readonly documents: Section<{
    id: string;
    category: string;
    fileName: string;
    note: string | null;
    createdAt: string;
  }>;
}

/** A store a party can belong to (GET /stores). */
export interface StoreOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** POST /parties/:id/merge: the surviving party and how many records moved, by table and column. */
export interface MergeResult {
  readonly party: Party;
  readonly moved: Readonly<Record<string, number>>;
}

export function partyEndpoints(api: ApiClient) {
  return {
    list: (query: PartyQuery, signal?: AbortSignal) =>
      api.get<Page<Party>>('/parties', { query: { ...query }, signal }),
    get: (id: string, signal?: AbortSignal) => api.get<Party>(`/parties/${id}`, { signal }),
    overview: (id: string, signal?: AbortSignal) =>
      api.get<PartyOverview>(`/parties/${id}/overview`, { signal }),
    create: (input: PartyInput) => api.post<Party>('/parties', input),
    update: (id: string, input: Partial<PartyInput> & { isActive?: boolean }) =>
      api.patch<Party>(`/parties/${id}`, input),
    /** Merges this duplicate into another party (all-store access and parties:manage). */
    merge: (id: string, intoPartyId: string) =>
      api.post<MergeResult>(`/parties/${id}/merge`, { intoPartyId }),
    /** Stores to choose a home store from. */
    stores: (signal?: AbortSignal) => api.get<StoreOption[]>('/stores', { signal }),
  };
}
