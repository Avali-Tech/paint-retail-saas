import type { NavItem } from '../shell/nav.js';

/** Contracts, in Customers after follow-ups. */
export const CONTRACT_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'contracts',
    section: 'customers',
    order: 60,
    label: 'nav.contracts',
    path: '/contracts',
    permission: 'contracts:read',
  },
];
