import type { NavItem } from '../shell/nav.js';

/** The tabs of Buy: purchase orders to suppliers, then the brands' schemes and statements. */
export const PURCHASING_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'purchaseOrders',
    section: 'buy',
    order: 10,
    label: 'purchasing.orders',
    path: '/purchase-orders',
    permission: 'purchasing:read',
  },
  {
    key: 'goodsReceipts',
    section: 'buy',
    order: 20,
    label: 'purchasing.receipts',
    path: '/goods-receipts',
    permission: 'purchasing:read',
  },
  {
    key: 'suppliers',
    section: 'buy',
    order: 30,
    label: 'purchasing.suppliers',
    path: '/suppliers',
    permission: 'purchasing:read',
  },
  {
    key: 'brandSchemes',
    section: 'buy',
    order: 40,
    label: 'schemes.title',
    path: '/brand-schemes',
    permission: 'purchasing:read',
  },
  {
    key: 'schemeClaims',
    section: 'buy',
    order: 50,
    label: 'schemes.claims.title',
    path: '/brand-schemes/claims',
    permission: 'purchasing:read',
  },
  {
    key: 'brandStatements',
    section: 'buy',
    order: 60,
    label: 'statements.title',
    path: '/brand-statements',
    permission: 'purchasing:read',
  },
  {
    key: 'priceHike',
    section: 'buy',
    order: 70,
    label: 'priceHike.title',
    path: '/brand-schemes/price-hike',
    permission: 'purchasing:read',
    // It plans from costs.
    alsoNeeds: 'costs:read',
  },
];
