import type { NavItem } from '../shell/nav.js';

/** Payments, the day end and the Tally export, in Money after collections. */
export const BOOKS_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'payments',
    section: 'money',
    order: 30,
    label: 'books.nav.payments',
    path: '/payments',
    permission: 'sales:read',
  },
  {
    key: 'registers',
    section: 'money',
    order: 40,
    label: 'books.nav.registers',
    path: '/registers',
    permission: 'register:manage',
  },
  {
    key: 'accounting',
    section: 'money',
    order: 50,
    label: 'books.nav.accounting',
    path: '/accounting/export',
    permission: 'accounting:export',
    // The ledger mapping and the reconciliation are screens of the export.
    owns: ['/accounting'],
  },
];
