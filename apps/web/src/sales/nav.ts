import type { NavItem } from '../shell/nav.js';

/** Invoices, then credit and debit notes (returns), in Sales. */
export const SALES_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'invoices',
    section: 'sales',
    order: 30,
    label: 'sales.nav.invoices',
    path: '/invoices',
    permission: 'sales:read',
  },
  {
    key: 'notes',
    section: 'sales',
    order: 40,
    label: 'sales.nav.notes',
    path: '/notes',
    permission: 'sales:read',
  },
];
