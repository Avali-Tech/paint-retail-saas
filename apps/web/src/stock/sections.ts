import type { SectionLink } from '../lib/SectionNav.js';

/** The screens of the stock section, linked from each of them. */
export const STOCK_SECTIONS: readonly SectionLink[] = [
  { to: '/stock', label: 'stock.sections.balances', permission: 'inventory:read' },
  { to: '/stock/low', label: 'stock.sections.low', permission: 'inventory:read' },
  { to: '/stock/reorder-rules', label: 'stock.sections.rules', permission: 'inventory:read' },
  { to: '/transfers', label: 'stock.sections.transfers', permission: 'inventory:read' },
  { to: '/stock-counts', label: 'stock.sections.counts', permission: 'inventory:read' },
];
