import type { NavItem } from '../shell/nav.js';

/** Home: the dashboard. */
export const DASHBOARD_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'dashboard',
    section: 'home',
    order: 10,
    label: 'nav.dashboard',
    path: '/dashboard',
    permission: 'stores:read',
  },
];
