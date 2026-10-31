import type { NavItem } from '../shell/nav.js';

/** The tabs of Stock after products: balances, moving stock, then what needs attention. */
export const STOCK_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'balances',
    section: 'stock',
    order: 20,
    label: 'stock.sections.balances',
    path: '/stock',
    permission: 'inventory:read',
  },
  {
    key: 'transfers',
    section: 'stock',
    order: 30,
    label: 'stock.sections.transfers',
    path: '/transfers',
    permission: 'inventory:read',
  },
  {
    key: 'stockCounts',
    section: 'stock',
    order: 40,
    label: 'stock.sections.counts',
    path: '/stock-counts',
    permission: 'inventory:read',
  },
  {
    key: 'lowStock',
    section: 'stock',
    order: 50,
    label: 'stock.sections.low',
    path: '/stock/low',
    permission: 'inventory:read',
  },
  {
    key: 'reorderRules',
    section: 'stock',
    order: 60,
    label: 'stock.sections.rules',
    path: '/stock/reorder-rules',
    permission: 'inventory:read',
  },
  {
    key: 'slowMovers',
    section: 'stock',
    order: 70,
    label: 'stock.sections.slow',
    path: '/stock/slow-movers',
    permission: 'inventory:read',
  },
  {
    key: 'mistints',
    section: 'stock',
    order: 80,
    label: 'stock.sections.mistints',
    path: '/stock/mistints',
    permission: 'inventory:read',
  },
];
