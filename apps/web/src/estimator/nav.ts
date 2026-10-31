import type { NavItem } from '../shell/nav.js';

/** Paint estimates, the last tab of Sales. */
export const ESTIMATE_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'estimates',
    section: 'sales',
    order: 50,
    label: 'estimator.nav.estimates',
    path: '/estimates',
    permission: 'sales:read',
  },
];
