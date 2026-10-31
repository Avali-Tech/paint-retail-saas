import type { NavItem } from '../shell/nav.js';

/** Settings → Stores and Settings → Billing go-live (PO-100, PO-102). */
export const SETUP_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'storeSettings',
    section: 'settings',
    group: 'business',
    order: 10,
    label: 'storeSettings.nav',
    path: '/settings/stores',
    permission: 'stores:manage',
  },
  {
    key: 'goLive',
    section: 'settings',
    group: 'business',
    order: 70,
    label: 'goLive.nav',
    path: '/settings/go-live',
    permission: 'organization:manage',
  },
];
