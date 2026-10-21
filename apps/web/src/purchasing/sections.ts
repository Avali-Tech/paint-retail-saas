import type { SectionLink } from '../lib/SectionNav.js';

/** The screens of the purchasing section, linked from each of them. */
export const PURCHASING_SECTIONS: readonly SectionLink[] = [
  { to: '/purchase-orders', label: 'purchasing.orders', permission: 'purchasing:read' },
  { to: '/goods-receipts', label: 'purchasing.receipts', permission: 'purchasing:read' },
  { to: '/suppliers', label: 'purchasing.suppliers', permission: 'purchasing:read' },
  { to: '/brand-schemes', label: 'schemes.title', permission: 'purchasing:read' },
  { to: '/brand-schemes/claims', label: 'schemes.claims.title', permission: 'purchasing:read' },
  // Plans from costs, so it needs costs:read (the purchasing pages need purchasing:read).
  { to: '/brand-schemes/price-hike', label: 'priceHike.title', permission: 'costs:read' },
  { to: '/brand-statements', label: 'statements.title', permission: 'purchasing:read' },
];
