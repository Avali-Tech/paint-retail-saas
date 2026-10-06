import type { FeatureFlag, PendingSignIn, PlanKey, SessionGrant } from '@paint/shared';
import type { ApiClient } from '../api/client.js';
import type { TwoFactorEnrolment } from '../api/types.js';

// The platform console's API routes (apps/api/src/platform). These shapes have
// no shared type yet; they mirror tenants.service.ts and support.service.ts.

/** POST /platform/login/2fa: an operator's session (no business). */
export interface PlatformSession {
  readonly token: string;
  readonly expiresAt: string;
}

export interface PlanView {
  readonly key: PlanKey;
  readonly name: string;
  /** null = unlimited. */
  readonly maxStores: number | null;
  readonly maxMembers: number | null;
}

export interface TenantUsage {
  readonly stores: number;
  readonly members: number;
  readonly products: number;
  readonly parties: number;
  readonly documents: number;
  readonly documentBytes: number;
  readonly lastSignInAt: string | null;
}

export type TenantStatus = 'active' | 'suspended';

export interface TenantView {
  readonly id: string;
  readonly name: string;
  readonly plan: PlanView;
  readonly status: TenantStatus;
  readonly suspendedAt: string | null;
  readonly suspendReason: string | null;
  /** The plan's features with this business's overrides applied. */
  readonly features: Record<FeatureFlag, boolean>;
  readonly featureOverrides: Partial<Record<FeatureFlag, boolean>>;
  readonly usage: TenantUsage;
  readonly createdAt: string;
}

export interface TenantDetail extends TenantView {
  readonly owners: readonly {
    readonly fullName: string;
    readonly phone: string | null;
    readonly email: string | null;
  }[];
}

export interface TenantPage {
  readonly items: TenantView[];
  readonly total: number;
}

export interface TenantQuery {
  readonly q?: string;
  readonly status?: TenantStatus;
  readonly limit: number;
  readonly offset: number;
}

/** PATCH /platform/tenants/:id: a flag set to null goes back to the plan's default. */
export interface TenantChange {
  readonly plan?: PlanKey;
  readonly featureFlags?: Partial<Record<FeatureFlag, boolean | null>>;
}

export type GrantStatus = 'pending' | 'declined' | 'active' | 'expired' | 'ended';

/** A support access request, as both the platform and the business see it. */
export interface GrantView {
  readonly id: string;
  readonly organization: { readonly id: string; readonly name: string };
  readonly requestedBy: string;
  readonly reason: string;
  readonly minutes: number;
  readonly status: GrantStatus;
  readonly requestedAt: string;
  readonly approvedAt: string | null;
  readonly declinedAt: string | null;
  readonly expiresAt: string | null;
  readonly endedAt: string | null;
}

export function platformEndpoints(api: ApiClient) {
  return {
    login: (identifier: string, password: string) =>
      api.post<{ twoFactor: PendingSignIn }>('/platform/login', { identifier, password }),
    setUpTwoFactor: (pendingToken: string) =>
      api.post<TwoFactorEnrolment>('/platform/login/2fa/setup', { pendingToken }),
    verifyTwoFactor: (pendingToken: string, code: string) =>
      api.post<PlatformSession & { recoveryCodes?: string[] }>('/platform/login/2fa', {
        pendingToken,
        code,
      }),
    logout: () => api.post<undefined>('/platform/logout'),
    tenants: (query: TenantQuery, signal?: AbortSignal) =>
      api.get<TenantPage>('/platform/tenants', { query: { ...query }, signal }),
    tenant: (id: string, signal?: AbortSignal) =>
      api.get<TenantDetail>(`/platform/tenants/${id}`, { signal }),
    updateTenant: (id: string, change: TenantChange) =>
      api.patch<TenantDetail>(`/platform/tenants/${id}`, change),
    suspend: (id: string, reason: string) =>
      api.post<TenantDetail>(`/platform/tenants/${id}/suspend`, { reason }),
    reactivate: (id: string) => api.post<TenantDetail>(`/platform/tenants/${id}/reactivate`),
    requestSupport: (tenantId: string, input: { reason: string; minutes: number }) =>
      api.post<GrantView>(`/platform/tenants/${tenantId}/support-requests`, input),
    grants: (tenantId?: string, signal?: AbortSignal) =>
      api.get<GrantView[]>('/platform/support-grants', { query: { tenantId }, signal }),
    /** A read-only session inside the business while the grant runs. */
    startSupportSession: (grantId: string) =>
      api.post<SessionGrant>(`/platform/support-grants/${grantId}/session`),
    endGrant: (grantId: string) => api.post<GrantView>(`/platform/support-grants/${grantId}/end`),
  };
}

export type PlatformEndpoints = ReturnType<typeof platformEndpoints>;
