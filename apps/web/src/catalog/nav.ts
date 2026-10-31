import type { NavItem } from '../shell/nav.js';

/** Products, the first tab of Stock. */
export const CATALOG_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'products',
    section: 'stock',
    order: 10,
    label: 'nav.products',
    path: '/products',
    permission: 'catalog:read',
  },
];
