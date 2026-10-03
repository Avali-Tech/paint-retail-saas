import type { Permission } from '@paint/shared';
import type { IconName } from '@paint/ui';
import type { MessageKey } from '../i18n/i18n.js';
import { IMPORT_NAV_ITEMS } from '../imports/nav.js';
import type { AnyOf } from '../lib/guard.js';
import { CUSTOMER_NAV_ITEMS } from '../parties/nav.js';

export interface NavItem {
  readonly key: string;
  readonly label: MessageKey;
  readonly path: string;
  readonly icon: IconName;
  /** Shown only to members holding this permission (or any of these). */
  readonly permission: Permission | AnyOf;
}

/** The main sections, in order. Phones show the first four in the bottom bar and the rest under "More". */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'dashboard',
    label: 'nav.dashboard',
    path: '/dashboard',
    icon: 'dashboard',
    permission: 'stores:read',
  },
  {
    key: 'customers',
    label: 'nav.customers',
    path: '/parties',
    icon: 'customers',
    permission: 'parties:read',
  },
  {
    key: 'products',
    label: 'nav.products',
    path: '/products',
    icon: 'products',
    permission: 'catalog:read',
  },
  { key: 'stock', label: 'nav.stock', path: '/stock', icon: 'stock', permission: 'inventory:read' },
  {
    key: 'purchasing',
    label: 'nav.purchasing',
    path: '/purchase-orders',
    icon: 'purchasing',
    permission: 'purchasing:read',
  },
  { key: 'leads', label: 'nav.leads', path: '/leads', icon: 'leads', permission: 'leads:read' },
  {
    key: 'projects',
    label: 'nav.projects',
    path: '/projects',
    icon: 'projects',
    permission: 'projects:read',
  },
  {
    key: 'contracts',
    label: 'nav.contracts',
    path: '/contracts',
    icon: 'contracts',
    permission: 'contracts:read',
  },
  // Each feature keeps its own entries in its own file.
  ...CUSTOMER_NAV_ITEMS,
  ...IMPORT_NAV_ITEMS,
  {
    key: 'appearance',
    label: 'nav.appearance',
    path: '/settings/appearance',
    icon: 'settings',
    permission: 'organization:manage',
  },
];

export const BOTTOM_BAR_SIZE = 4;

/** The sections a member may open. */
export function visibleNav(can: (permission: Permission) => boolean): NavItem[] {
  return NAV_ITEMS.filter((item) =>
    typeof item.permission === 'string' ? can(item.permission) : item.permission.some(can),
  );
}
