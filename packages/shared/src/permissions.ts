/**
 * Every permission in the product. Keys are stored in role_permissions, so
 * never rename one: add a new key and migrate instead. Extended as modules ship.
 */
export const PERMISSIONS = [
  'organization:manage',
  'members:read',
  'members:manage',
  'roles:manage',
  'stores:read',
  'stores:manage',
  'parties:read',
  'parties:manage',
  'catalog:read',
  'catalog:manage',
  'inventory:read',
  'inventory:manage',
  'purchasing:read',
  'purchasing:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

/** True when `value` is a known permission key (e.g. read back from the database). */
export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

export interface SystemRole {
  readonly key: string;
  readonly name: string;
  readonly permissions: readonly Permission[];
  /** Members with this role see every store, including stores added later. */
  readonly allStores: boolean;
}

/** Roles created for every new organisation (roadmap §3.2). */
export const SYSTEM_ROLES: readonly SystemRole[] = [
  { key: 'owner', name: 'Owner', permissions: PERMISSIONS, allStores: true },
  { key: 'org_admin', name: 'Organization Admin', permissions: PERMISSIONS, allStores: true },
  {
    key: 'branch_manager',
    name: 'Branch Manager',
    permissions: [
      'stores:read',
      'members:read',
      'parties:read',
      'parties:manage',
      'catalog:read',
      'inventory:read',
      'inventory:manage',
      'purchasing:read',
    ],
    allStores: false,
  },
  {
    key: 'inventory_manager',
    name: 'Inventory Manager',
    permissions: [
      'stores:read',
      'parties:read',
      'catalog:read',
      'catalog:manage',
      'inventory:read',
      'inventory:manage',
      'purchasing:read',
      'purchasing:manage',
    ],
    allStores: false,
  },
  {
    key: 'sales_executive',
    name: 'Sales Executive',
    permissions: [
      'stores:read',
      'parties:read',
      'parties:manage',
      'catalog:read',
      'inventory:read',
    ],
    allStores: false,
  },
  {
    key: 'crm_executive',
    name: 'CRM Executive',
    permissions: ['stores:read', 'parties:read', 'parties:manage', 'catalog:read'],
    allStores: false,
  },
  {
    key: 'store_employee',
    name: 'Store Employee',
    permissions: ['stores:read', 'parties:read', 'catalog:read', 'inventory:read'],
    allStores: false,
  },
];

/** What a signed-in member may do: their role's permissions and their store access. */
export interface MemberAccess {
  readonly permissions: ReadonlySet<Permission>;
  readonly allStores: boolean;
  readonly storeIds: ReadonlySet<string>;
}

/** True when the member has access to `storeId`. */
export function canAccessStore(access: MemberAccess, storeId: string): boolean {
  return access.allStores || access.storeIds.has(storeId);
}

/**
 * True when the member holds `permission` and, if `storeId` is given, has
 * access to that store. A Branch Manager of Hyderabad can read Hyderabad, not Pune.
 */
export function can(access: MemberAccess, permission: Permission, storeId?: string): boolean {
  if (!access.permissions.has(permission)) return false;
  return storeId === undefined || canAccessStore(access, storeId);
}
