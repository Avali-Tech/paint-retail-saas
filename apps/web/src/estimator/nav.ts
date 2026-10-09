import type { NavItem } from '../shell/nav.js';

/** Paint estimates, just before quotations: estimate → quote → order → invoice. */
export const ESTIMATE_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'estimates',
    label: 'estimator.nav.estimates',
    path: '/estimates',
    icon: 'contracts',
    permission: 'sales:read',
  },
];
