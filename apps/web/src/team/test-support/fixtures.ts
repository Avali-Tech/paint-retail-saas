import { PERMISSIONS, SYSTEM_ROLES, type Permission } from '@paint/shared';
import type { Member, Role } from '../../api/team.js';

// Team and roles data for component tests.

const systemRole = (key: string): Role => {
  const role = SYSTEM_ROLES.find((candidate) => candidate.key === key);
  if (!role) throw new Error(`No system role ${key}`);
  return {
    id: `role-${key}`,
    key,
    name: role.name,
    isSystem: true,
    permissions: [...role.permissions],
    memberCount: 1,
  };
};

export const OWNER_ROLE = systemRole('owner');
export const ADMIN_ROLE = systemRole('org_admin');
export const MANAGER_ROLE = systemRole('branch_manager');
export const EMPLOYEE_ROLE = systemRole('store_employee');
export const CASHIER_ROLE: Role = {
  id: 'role-cashier',
  key: 'custom_1a2b3c4d',
  name: 'Cashier',
  isSystem: false,
  permissions: ['parties:read', 'stores:read'],
  memberCount: 0,
};

export const ROLES: Role[] = [ADMIN_ROLE, MANAGER_ROLE, CASHIER_ROLE, OWNER_ROLE, EMPLOYEE_ROLE];

export function member(
  id: string,
  fullName: string,
  role: Role,
  overrides: Partial<Member> = {},
): Member {
  return {
    id,
    user: { id: `user-${id}`, fullName, phone: '+919876500001', email: null },
    role: { id: role.id, key: role.key, name: role.name },
    allStores: false,
    storeIds: ['store-hyd'],
    isActive: true,
    twoFactorEnabled: false,
    ...overrides,
  };
}

/** The owner as GET /members shows them: the fake profile's user (user-1). */
export const ME = member('m-me', 'Anil Kumar', OWNER_ROLE, {
  user: { id: 'user-1', fullName: 'Anil Kumar', phone: '+919876543210', email: null },
  allStores: true,
  storeIds: [],
  twoFactorEnabled: true,
});
export const SURESH = member('m-suresh', 'Suresh Counter', EMPLOYEE_ROLE);
export const PRIYA = member('m-priya', 'Priya Manager', MANAGER_ROLE, {
  user: { id: 'user-priya', fullName: 'Priya Manager', phone: null, email: 'priya@abc.in' },
  storeIds: ['store-hyd', 'store-pun', 'store-far'],
  twoFactorEnabled: true,
});
export const OLD = member('m-old', 'Old Staff', EMPLOYEE_ROLE, { isActive: false, storeIds: [] });

export const MEMBERS: Member[] = [ME, OLD, PRIYA, SURESH];

/** Every permission except those listed. */
export const allBut = (...left: Permission[]): Permission[] =>
  PERMISSIONS.filter((permission) => !left.includes(permission));
