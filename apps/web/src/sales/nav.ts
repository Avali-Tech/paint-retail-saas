import type { NavItem } from '../shell/nav.js';

/** Invoices and notes, after contracts in the navigation. */
export const SALES_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'invoices',
    label: 'sales.nav.invoices',
    path: '/invoices',
    icon: 'contracts',
    permission: 'sales:read',
  },
  {
    key: 'notes',
    label: 'sales.nav.notes',
    path: '/notes',
    icon: 'contracts',
    permission: 'sales:read',
  },
];
