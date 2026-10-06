import { resolveFeatures } from '@paint/shared';
import type { GrantView, TenantDetail } from '../platform/platform-api.js';
import { PLATFORM_SESSION_KEY } from '../platform/platform-session-store.js';

// Platform console data for component tests, shaped like apps/api/src/platform answers.

export const OPERATOR_SESSION = {
  token: 'operator-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

/** Signs the console in on this device, as a previous visit would have. */
export function signInOperator(): void {
  localStorage.setItem(PLATFORM_SESSION_KEY, JSON.stringify(OPERATOR_SESSION));
}

export const TENANT_ID = '00000000-0000-4000-8000-0000000000a1';

export function tenant(overrides: Partial<TenantDetail> = {}): TenantDetail {
  return {
    id: TENANT_ID,
    name: 'Sharma Paints',
    plan: { key: 'trial', name: 'Trial', maxStores: 5, maxMembers: 25 },
    status: 'active',
    suspendedAt: null,
    suspendReason: null,
    features: resolveFeatures('trial', {}),
    featureOverrides: {},
    usage: {
      stores: 5,
      members: 12,
      products: 1_250,
      parties: 84,
      documents: 3,
      documentBytes: 1_572_864,
      lastSignInAt: '2026-10-01T04:30:00.000Z',
    },
    createdAt: '2026-08-01T04:30:00.000Z',
    owners: [{ fullName: 'Rajesh Sharma', phone: '+919000000001', email: 'rajesh@sharma.in' }],
    ...overrides,
  };
}

export function grant(overrides: Partial<GrantView> = {}): GrantView {
  return {
    id: '00000000-0000-4000-8000-0000000000b1',
    organization: { id: TENANT_ID, name: 'Sharma Paints' },
    requestedBy: 'Asha Operator',
    reason: 'Stock report looks wrong',
    minutes: 60,
    status: 'pending',
    requestedAt: '2026-10-01T04:30:00.000Z',
    approvedAt: null,
    declinedAt: null,
    expiresAt: null,
    endedAt: null,
    ...overrides,
  };
}

export const ACTIVE_GRANT = grant({
  id: '00000000-0000-4000-8000-0000000000b2',
  status: 'active',
  approvedAt: '2026-10-01T05:00:00.000Z',
  expiresAt: '2026-10-01T06:00:00.000Z',
});
