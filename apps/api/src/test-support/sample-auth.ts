import type { AuthContext } from '../auth/auth-context.js';

/** A Branch Manager of two stores, for unit tests. */
export const sampleAuth: AuthContext = {
  sessionId: 'session-1',
  memberId: 'member-1',
  user: { id: 'user-1', fullName: 'Raj Kumar', phone: '+919800000001', email: null },
  organization: { id: 'org-1', name: 'ABC Paints' },
  role: { key: 'branch_manager', name: 'Branch Manager' },
  permissions: new Set(['stores:read', 'members:read']),
  allStores: false,
  storeIds: new Set(['store-b', 'store-a']),
};
