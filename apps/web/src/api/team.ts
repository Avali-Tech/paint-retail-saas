import type {
  AssignableMember,
  MemberView,
  Permission,
  PermissionExceptions,
  RoleView,
} from '@paint/shared';
import type { ApiClient } from './client.js';

// Team members and roles. Shapes are shared with apps/api/src/members.

export type Member = MemberView;
export type Role = RoleView;
export type { AssignableMember };

/**
 * GET /members/assignable: who a record can be handed to. `for` is the kind of
 * record (an activity names the record type it is on); `storeId` its store,
 * left out for business-wide records.
 */
export type AssignmentQuery =
  | { readonly for: 'lead' | 'opportunity' | 'project' | 'contract'; readonly storeId?: string }
  | {
      readonly for: 'activity';
      readonly recordType: 'party' | 'lead' | 'opportunity' | 'project';
      readonly storeId?: string;
    };

/** POST /members: a new person, or an existing account linked to this business. */
export interface MemberInput {
  readonly fullName: string;
  readonly phone?: string;
  readonly email?: string;
  /** Without one, the person signs in with a code texted to their mobile. */
  readonly password?: string;
  readonly roleId: string;
  readonly allStores: boolean;
  readonly storeIds: readonly string[];
}

/** PATCH /members/:id: only what changes. */
export interface MemberChange {
  readonly roleId?: string;
  readonly allStores?: boolean;
  readonly storeIds?: readonly string[];
  /** Replaces the member's own exceptions to their role. */
  readonly exceptions?: PermissionExceptions;
  readonly isActive?: boolean;
}

/** POST /roles and PATCH /roles/:id. */
export interface RoleInput {
  readonly name: string;
  readonly permissions: readonly Permission[];
}

export function teamEndpoints(api: ApiClient) {
  return {
    members: (signal?: AbortSignal) => api.get<Member[]>('/members', { signal }),
    member: (id: string, signal?: AbortSignal) => api.get<Member>(`/members/${id}`, { signal }),
    /** No members:read needed: anyone who may create such records can ask. */
    assignable: (query: AssignmentQuery, signal?: AbortSignal) =>
      api.get<AssignableMember[]>('/members/assignable', { query: { ...query }, signal }),
    addMember: (input: MemberInput) => api.post<Member>('/members', input),
    updateMember: (id: string, change: MemberChange) => api.patch<Member>(`/members/${id}`, change),
    /** Owners only: removes the member's authenticator app and signs them out. */
    resetTwoFactor: (id: string) => api.post<undefined>(`/members/${id}/two-factor/reset`),
    roles: (signal?: AbortSignal) => api.get<Role[]>('/roles', { signal }),
    createRole: (input: RoleInput) => api.post<Role>('/roles', input),
    updateRole: (id: string, input: Partial<RoleInput>) => api.patch<Role>(`/roles/${id}`, input),
  };
}
