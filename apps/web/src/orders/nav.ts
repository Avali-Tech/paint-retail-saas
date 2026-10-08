import type { NavItem } from '../shell/nav.js';

/** Quotations and sales orders, just before invoices: quote → order → invoice. */
export const ORDER_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'quotations',
    label: 'orders.nav.quotations',
    path: '/quotations',
    icon: 'contracts',
    permission: 'sales:read',
  },
  {
    key: 'sales-orders',
    label: 'orders.nav.orders',
    path: '/sales-orders',
    icon: 'contracts',
    permission: 'sales:read',
  },
];
