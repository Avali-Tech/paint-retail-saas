import type { NavItem } from '../shell/nav.js';

/** Settings → Getting started, Stores and Billing go-live (PO-100, PO-102). */
export const SETUP_NAV_ITEMS: readonly NavItem[] = [
  {
    // The first steps of a new business, first in Settings (also on Home until done).
    key: 'gettingStarted',
    section: 'settings',
    group: 'business',
    order: 5,
    label: 'gettingStarted.title',
    path: '/settings/getting-started',
    permission: 'organization:manage',
  },
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
