import type { NavItem } from '../shell/nav.js';

/** The day end, payments and the Tally export, after invoices and notes in the navigation. */
export const BOOKS_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'registers',
    label: 'books.nav.registers',
    path: '/registers',
    icon: 'calendar',
    permission: 'register:manage',
  },
  {
    key: 'payments',
    label: 'books.nav.payments',
    path: '/payments',
    icon: 'check',
    permission: 'sales:read',
  },
  {
    key: 'accounting',
    label: 'books.nav.accounting',
    path: '/accounting/export',
    icon: 'contracts',
    permission: 'accounting:export',
  },
];
