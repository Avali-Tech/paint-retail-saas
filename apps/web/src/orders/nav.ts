import type { NavItem } from '../shell/nav.js';

/** Quotations and sales orders, the first tabs of Sales: quote → order → invoice. */
export const ORDER_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'quotations',
    section: 'sales',
    order: 10,
    label: 'orders.nav.quotations',
    path: '/quotations',
    permission: 'sales:read',
  },
  {
    key: 'sales-orders',
    section: 'sales',
    order: 20,
    label: 'orders.nav.orders',
    path: '/sales-orders',
    permission: 'sales:read',
  },
];
