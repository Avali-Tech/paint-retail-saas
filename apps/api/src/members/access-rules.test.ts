import { PERMISSIONS, type Permission } from '@paint/shared';
import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../auth/auth-context.js';
import { sampleAuth } from '../test-support/sample-auth.js';
import { canSeeMember, grantProblem, manageProblem, type AccessGrant } from './access-rules.js';

const HYD = 'store-hyd';
const PUNE = 'store-pune';

const manager = (
  roleKey: string,
  permissions: readonly Permission[],
  access: { allStores?: boolean; storeIds?: string[] } = {},
): AuthContext => ({
  ...sampleAuth,
  role: { key: roleKey, name: roleKey },
  permissions: new Set(permissions),
  allStores: access.allStores ?? false,
  storeIds: new Set(access.storeIds ?? []),
});

const owner = manager('owner', PERMISSIONS, { allStores: true });
const admin = manager('org_admin', PERMISSIONS, { allStores: true });
const hydLead = manager('hyd_lead', ['members:read', 'members:manage', 'stores:read'], {
  storeIds: [HYD],
});

const grant = (overrides: Partial<AccessGrant> = {}): AccessGrant => ({
  roleKey: 'store_employee',
  rolePermissions: ['stores:read'],
  allStores: false,
  storeIds: [HYD],
  ...overrides,
});

describe('grantProblem', () => {
  it('lets an owner give any access, including ownership', () => {
    expect(grantProblem(owner, grant())).toBeNull();
    expect(
      grantProblem(
        owner,
        grant({ roleKey: 'owner', rolePermissions: PERMISSIONS, allStores: true }),
      ),
    ).toBeNull();
  });

  it('stops anyone but an owner making an owner', () => {
    expect(grantProblem(admin, grant({ roleKey: 'owner', rolePermissions: PERMISSIONS }))).toBe(
      'Only an owner can make someone an owner',
    );
  });

  it('stops giving permissions the manager does not hold', () => {
    expect(
      grantProblem(hydLead, grant({ rolePermissions: ['stores:read', 'stores:manage'] })),
    ).toBe('You cannot give permissions you do not have');
  });

  it('stops a store-scoped manager giving all-store access', () => {
    expect(grantProblem(hydLead, grant({ allStores: true }))).toBe(
      'You cannot give access to all stores',
    );
  });

  it('stops a manager giving access to stores outside their own', () => {
    expect(grantProblem(hydLead, grant({ storeIds: [HYD, PUNE] }))).toBe(
      'You cannot give access to stores you cannot access',
    );
    expect(grantProblem(hydLead, grant({ storeIds: [HYD] }))).toBeNull();
  });
});

describe('manageProblem', () => {
  const target = (overrides: Partial<AccessGrant & { userId: string }> = {}) => ({
    ...grant(),
    userId: 'someone-else',
    ...overrides,
  });

  it('lets a manager change someone within their reach', () => {
    expect(manageProblem(hydLead, target())).toBeNull();
  });

  it('never lets anyone change their own access', () => {
    expect(manageProblem(owner, target({ userId: owner.user.id }))).toBe(
      'You cannot change your own access',
    );
  });

  it('stops changes to someone with more access than the manager', () => {
    expect(manageProblem(hydLead, target({ storeIds: [PUNE] }))).toBe(
      'This member has access you are not allowed to manage',
    );
    expect(
      manageProblem(
        admin,
        target({ roleKey: 'owner', rolePermissions: PERMISSIONS, allStores: true }),
      ),
    ).toBe('This member has access you are not allowed to manage');
  });
});

describe('canSeeMember', () => {
  it('lets all-store managers see everyone', () => {
    expect(canSeeMember(owner, { userId: 'x', storeIds: [] })).toBe(true);
  });

  it('lets store-scoped managers see people in their stores and themselves only', () => {
    expect(canSeeMember(hydLead, { userId: 'x', storeIds: [HYD, PUNE] })).toBe(true);
    expect(canSeeMember(hydLead, { userId: 'x', storeIds: [PUNE] })).toBe(false);
    expect(canSeeMember(hydLead, { userId: 'x', storeIds: [] })).toBe(false);
    expect(canSeeMember(hydLead, { userId: hydLead.user.id, storeIds: [] })).toBe(true);
  });
});
