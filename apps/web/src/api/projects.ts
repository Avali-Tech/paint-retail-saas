import type { ApiClient } from './client.js';
import type { CrmQuery, Person } from './leads.js';
import type { Page } from './page.js';

// Projects (sites). Shapes mirror apps/api/src/projects (not yet in @paint/shared).

export const PROJECT_STAGES = [
  'identified',
  'survey',
  'specification',
  'quotation',
  'negotiation',
  'order',
  'execution',
  'completed',
  'cancelled',
] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

/** Stages a project is moved between by hand; cancelling has its own action. */
export const WORK_STAGES = [
  'identified',
  'survey',
  'specification',
  'quotation',
  'negotiation',
  'order',
  'execution',
  'completed',
] as const;
export type WorkStage = (typeof WORK_STAGES)[number];

/** The people on a project besides its customer (the owner). */
export const PROJECT_PARTY_ROLES = ['architect', 'contractor', 'painter', 'dealer'] as const;
export type ProjectPartyRole = (typeof PROJECT_PARTY_ROLES)[number];

export interface ProjectPartyLink {
  readonly partyId: string;
  readonly role: ProjectPartyRole;
}

interface StoreRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

interface Customer {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
}

export interface Site {
  readonly addressLine: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly pincode: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

export interface Project {
  readonly id: string;
  readonly number: string;
  readonly store: StoreRef;
  readonly name: string;
  readonly customer: Customer;
  readonly opportunity: { readonly id: string; readonly number: string } | null;
  readonly site: Site;
  readonly startDate: string | null;
  readonly expectedCompletionDate: string | null;
  readonly estimatedAreaSqFt: number | null;
  readonly estimatedPaintLitres: number | null;
  readonly expectedOrderValuePaise: number | null;
  readonly stage: ProjectStage;
  readonly cancelReason: string | null;
  readonly notes: string | null;
  readonly assignedTo: Person;
  readonly parties: (ProjectPartyLink & { readonly name: string; readonly phone: string | null })[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface ProjectSummary {
  readonly id: string;
  readonly number: string;
  readonly name: string;
  readonly store: StoreRef;
  readonly customer: Customer;
  readonly city: string | null;
  readonly stage: ProjectStage;
  readonly expectedOrderValuePaise: number | null;
  readonly assignedTo: Person;
  readonly updatedAt: string;
}

/** Site and job details; PATCH takes null to clear one. */
export interface ProjectDetails {
  readonly name?: string;
  readonly addressLine?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly pincode?: string | null;
  readonly startDate?: string | null;
  readonly expectedCompletionDate?: string | null;
  readonly estimatedAreaSqFt?: number | null;
  readonly estimatedPaintLitres?: number | null;
  readonly expectedOrderValuePaise?: number | null;
  readonly notes?: string | null;
}

/** POST /projects. */
export interface ProjectInput extends ProjectDetails {
  readonly storeId: string;
  readonly customerPartyId: string;
  readonly name: string;
  readonly assignedMemberId?: string;
}

export interface ProjectQuery extends CrmQuery {
  readonly stage?: ProjectStage | undefined;
  readonly partyId?: string | undefined;
}

export function projectEndpoints(api: ApiClient) {
  return {
    list: (query: ProjectQuery, signal?: AbortSignal) =>
      api.get<Page<ProjectSummary>>('/projects', { query: { ...query }, signal }),
    get: (id: string, signal?: AbortSignal) => api.get<Project>(`/projects/${id}`, { signal }),
    create: (input: ProjectInput) => api.post<Project>('/projects', input),
    /** Starts the project for an open or won opportunity. */
    fromOpportunity: (opportunityId: string) =>
      api.post<Project>(`/opportunities/${opportunityId}/project`),
    update: (id: string, changes: ProjectDetails) => api.patch<Project>(`/projects/${id}`, changes),
    /** Replaces the architects, contractors, painters and dealers. */
    setParties: (id: string, parties: readonly ProjectPartyLink[]) =>
      api.put<Project>(`/projects/${id}/parties`, { parties }),
    assign: (id: string, memberId: string) =>
      api.post<Project>(`/projects/${id}/assign`, { memberId }),
    moveTo: (id: string, stage: WorkStage) => api.post<Project>(`/projects/${id}/stage`, { stage }),
    cancel: (id: string, reason: string) => api.post<Project>(`/projects/${id}/cancel`, { reason }),
  };
}
