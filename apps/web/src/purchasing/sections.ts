import type { SectionLink } from '../lib/SectionNav.js';

/** The screens of the purchasing section, linked from each of them. */
export const PURCHASING_SECTIONS: readonly SectionLink[] = [
  { to: '/purchase-orders', label: 'purchasing.orders', permission: 'purchasing:read' },
  { to: '/goods-receipts', label: 'purchasing.receipts', permission: 'purchasing:read' },
  { to: '/suppliers', label: 'purchasing.suppliers', permission: 'purchasing:read' },
];
