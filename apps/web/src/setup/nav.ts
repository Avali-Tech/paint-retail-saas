import type { NavItem } from '../shell/nav.js';

/** Settings → Stores and Settings → Billing go-live (PO-100, PO-102). */
export const SETUP_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'storeSettings',
    label: 'storeSettings.nav',
    path: '/settings/stores',
    icon: 'settings',
    permission: 'stores:manage',
  },
  {
    key: 'goLive',
    label: 'goLive.nav',
    path: '/settings/go-live',
    icon: 'settings',
    permission: 'organization:manage',
  },
];
