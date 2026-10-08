import type { NavItem } from '../shell/nav.js';

/** The counter sale, right after the dashboard: one tap from anywhere for counter staff. */
export const POS_NAV_ITEMS: readonly NavItem[] = [
  { key: 'pos', label: 'pos.nav', path: '/pos', icon: 'store', permission: 'billing:issue' },
];
