import { PERMISSIONS, type Permission } from '@paint/shared';
import type { MessageKey } from '../i18n/i18n.js';

/** The area a permission belongs to: the part of its key before the colon. */
export type PermissionArea = Permission extends `${infer Area}:${string}` ? Area : never;

/** Readable names of each permission, so a role's checklist never shows raw keys. */
export const PERMISSION_LABELS: Record<Permission, MessageKey> = {
  'organization:manage': 'permissions.organization.manage',
  'members:read': 'permissions.members.read',
  'members:manage': 'permissions.members.manage',
  'roles:manage': 'permissions.roles.manage',
  'stores:read': 'permissions.stores.read',
  'stores:manage': 'permissions.stores.manage',
  'parties:read': 'permissions.parties.read',
  'parties:manage': 'permissions.parties.manage',
  'catalog:read': 'permissions.catalog.read',
  'catalog:manage': 'permissions.catalog.manage',
  'inventory:read': 'permissions.inventory.read',
  'inventory:manage': 'permissions.inventory.manage',
  'purchasing:read': 'permissions.purchasing.read',
  'purchasing:manage': 'permissions.purchasing.manage',
  'leads:read': 'permissions.leads.read',
  'leads:manage': 'permissions.leads.manage',
  'projects:read': 'permissions.projects.read',
  'projects:manage': 'permissions.projects.manage',
  'contracts:read': 'permissions.contracts.read',
  'contracts:manage': 'permissions.contracts.manage',
  'credit:read': 'permissions.credit.read',
  'credit:manage': 'permissions.credit.manage',
  'credit:approve': 'permissions.credit.approve',
  'credit:approve_sale': 'permissions.credit.approveSale',
  'loyalty:read': 'permissions.loyalty.read',
  'loyalty:manage': 'permissions.loyalty.manage',
  'audit:read': 'permissions.audit.read',
  'tax:read': 'permissions.tax.read',
  'tax:manage': 'permissions.tax.manage',
  'sales:read': 'permissions.sales.read',
  'sales:manage': 'permissions.sales.manage',
  'billing:issue': 'permissions.billing.issue',
  'billing:cancel': 'permissions.billing.cancel',
  'billing:notes': 'permissions.billing.notes',
  'payments:manage': 'permissions.payments.manage',
  'register:manage': 'permissions.register.manage',
  'accounting:export': 'permissions.accounting.export',
  'accounting:reconcile': 'permissions.accounting.reconcile',
  'receivables:read': 'permissions.receivables.read',
  'schemes:manage': 'permissions.schemes.manage',
};

/** Names of the areas, in the order the checklist shows them. */
export const AREA_LABELS: Record<PermissionArea, MessageKey> = {
  organization: 'permissions.areas.organization',
  members: 'permissions.areas.members',
  roles: 'permissions.areas.roles',
  stores: 'permissions.areas.stores',
  parties: 'permissions.areas.parties',
  catalog: 'permissions.areas.catalog',
  inventory: 'permissions.areas.inventory',
  purchasing: 'permissions.areas.purchasing',
  leads: 'permissions.areas.leads',
  projects: 'permissions.areas.projects',
  contracts: 'permissions.areas.contracts',
  credit: 'permissions.areas.credit',
  loyalty: 'permissions.areas.loyalty',
  audit: 'permissions.areas.audit',
  tax: 'permissions.areas.tax',
  sales: 'permissions.areas.sales',
  billing: 'permissions.areas.billing',
  payments: 'permissions.areas.payments',
  register: 'permissions.areas.register',
  accounting: 'permissions.areas.accounting',
  receivables: 'permissions.areas.receivables',
  schemes: 'permissions.areas.schemes',
};

export interface PermissionGroup {
  readonly area: PermissionArea;
  readonly permissions: readonly Permission[];
}

const areaOf = (permission: Permission) => permission.split(':')[0] as PermissionArea;

/** Every permission, grouped by area in the order of AREA_LABELS. */
export const PERMISSION_GROUPS: readonly PermissionGroup[] = (
  Object.keys(AREA_LABELS) as PermissionArea[]
).map((area) => ({
  area,
  permissions: PERMISSIONS.filter((permission) => areaOf(permission) === area),
}));
