import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  SYSTEM_ROLES,
  can,
  canAccessStore,
  effectivePermissions,
  isPermission,
  type MemberAccess,
  type Permission,
} from './index.js';

const HYD = 'store-hyderabad';
const PUNE = 'store-pune';

const access = (
  permissions: Permission[],
  { allStores = false, storeIds = [] as string[] } = {},
): MemberAccess => ({
  permissions: new Set(permissions),
  allStores,
  storeIds: new Set(storeIds),
});

describe('isPermission', () => {
  it('recognises every catalogue key', () => {
    for (const permission of PERMISSIONS) {
      expect(isPermission(permission)).toBe(true);
    }
  });

  it.each(['', 'stores', 'stores:delete', 'STORES:READ'])('rejects "%s"', (value) => {
    expect(isPermission(value)).toBe(false);
  });
});

describe('can', () => {
  const branchManager = access(['stores:read', 'members:read'], { storeIds: [HYD] });
  const owner = access([...PERMISSIONS], { allStores: true });

  it('allows a permission the role grants, when no store is involved', () => {
    expect(can(branchManager, 'stores:read')).toBe(true);
  });

  it('denies a permission the role does not grant, whatever the store', () => {
    expect(can(branchManager, 'stores:manage')).toBe(false);
    expect(can(branchManager, 'stores:manage', HYD)).toBe(false);
  });

  it('limits store-level actions to the member’s own stores', () => {
    expect(can(branchManager, 'stores:read', HYD)).toBe(true);
    expect(can(branchManager, 'stores:read', PUNE)).toBe(false);
  });

  it('lets all-store members act on any store, including new ones', () => {
    expect(can(owner, 'stores:manage', PUNE)).toBe(true);
    expect(can(owner, 'stores:manage', 'store-opened-tomorrow')).toBe(true);
  });

  it('denies everything to a member with no permissions', () => {
    expect(can(access([], { allStores: true }), 'stores:read', HYD)).toBe(false);
  });
});

describe('canAccessStore', () => {
  it('is true for assigned stores and for all-store members only', () => {
    expect(canAccessStore(access([], { storeIds: [HYD] }), HYD)).toBe(true);
    expect(canAccessStore(access([], { storeIds: [HYD] }), PUNE)).toBe(false);
    expect(canAccessStore(access([], { allStores: true }), PUNE)).toBe(true);
  });
});

describe('SYSTEM_ROLES', () => {
  it('matches the roles in the roadmap, with unique keys', () => {
    const keys = SYSTEM_ROLES.map((role) => role.key);

    expect(keys).toEqual([
      'owner',
      'org_admin',
      'branch_manager',
      'inventory_manager',
      'sales_executive',
      'crm_executive',
      'store_employee',
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives owners and admins every permission across all stores', () => {
    for (const key of ['owner', 'org_admin']) {
      const role = SYSTEM_ROLES.find((r) => r.key === key);
      expect(role?.allStores).toBe(true);
      expect([...(role?.permissions ?? [])].sort()).toEqual([...PERMISSIONS].sort());
    }
  });

  it('keeps branch roles store-scoped and unable to change organisation settings', () => {
    for (const role of SYSTEM_ROLES.filter((r) => !['owner', 'org_admin'].includes(r.key))) {
      expect(role.allStores).toBe(false);
      expect(role.permissions).not.toContain('organization:manage');
      expect(role.permissions).not.toContain('roles:manage');
    }
  });

  it('uses only catalogue permissions, with no gaps or duplicates', () => {
    for (const role of SYSTEM_ROLES) {
      // Array.from turns empty slots into undefined, which every() alone would skip.
      expect(Array.from(role.permissions).every((permission) => isPermission(permission))).toBe(
        true,
      );
      expect(new Set(role.permissions).size).toBe(role.permissions.length);
    }
  });
});

describe('effectivePermissions', () => {
  it('adds what is granted to the role and takes away what is denied, a denial winning', () => {
    const effective = effectivePermissions(['sales:read', 'billing:issue', 'billing:discount'], {
      granted: ['billing:cancel', 'costs:read'],
      denied: ['billing:discount', 'costs:read'],
    });
    expect([...effective].sort()).toEqual(['billing:cancel', 'billing:issue', 'sales:read']);
  });

  it('is the role as it is without exceptions', () => {
    expect([...effectivePermissions(['sales:read'], { granted: [], denied: [] })]).toEqual([
      'sales:read',
    ]);
  });
});

describe('split-out permissions', () => {
  it('come with what they were part of, so standard roles keep what they could do', () => {
    for (const role of SYSTEM_ROLES) {
      const has = (permission: Permission) => role.permissions.includes(permission);
      expect(has('billing:discount')).toBe(has('billing:issue'));
      expect(has('billing:on_account')).toBe(has('billing:issue'));
      expect(has('costs:read')).toBe(has('inventory:read') || has('purchasing:read'));
      expect(has('data:export')).toBe(true);
    }
  });
});
