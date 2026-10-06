import type { MemberAccess, Permission } from './permissions.js';

export interface QuickAction {
  readonly key: string;
  readonly label: string;
  /** Where the web app opens it. */
  readonly path: string;
  /** Keys pressed one after the other, e.g. "N C" for a new customer. */
  readonly shortcut: string;
  /** Any of these permissions shows the action; none = everyone. */
  readonly anyOf: readonly Permission[];
  /** Other words people type to find it. */
  readonly keywords: readonly string[];
}

/** Things people do often, offered next to search results (roadmap P1-M21). */
export const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    key: 'new_customer',
    label: '+ Customer',
    path: '/parties/new',
    shortcut: 'N C',
    anyOf: ['parties:manage'],
    keywords: ['party', 'contractor', 'painter', 'supplier', 'add'],
  },
  {
    key: 'new_lead',
    label: '+ Lead',
    path: '/leads/new',
    shortcut: 'N L',
    anyOf: ['leads:manage'],
    keywords: ['enquiry', 'inquiry', 'add'],
  },
  {
    key: 'new_project',
    label: '+ Project',
    path: '/projects/new',
    shortcut: 'N P',
    anyOf: ['projects:manage'],
    keywords: ['site', 'add'],
  },
  {
    key: 'new_contract',
    label: '+ Contract',
    path: '/contracts/new',
    shortcut: 'N A',
    anyOf: ['contracts:manage'],
    keywords: ['agreement', 'rate contract', 'dealer', 'add'],
  },
  {
    key: 'new_credit_request',
    label: '+ Credit request',
    path: '/credit-requests/new',
    shortcut: 'N K',
    anyOf: ['credit:manage'],
    keywords: ['limit', 'udhaar', 'credit days', 'approval'],
  },
  {
    key: 'new_loyalty_account',
    label: '+ Loyalty',
    path: '/loyalty/new',
    shortcut: 'N Y',
    anyOf: ['loyalty:manage'],
    keywords: ['points', 'reward', 'enrol', 'painter'],
  },
  {
    key: 'new_transfer',
    label: '+ Transfer',
    path: '/transfers/new',
    shortcut: 'N T',
    anyOf: ['inventory:manage'],
    keywords: ['stock', 'move', 'branch', 'add'],
  },
  {
    key: 'record_stock',
    label: 'Record stock movement',
    path: '/stock/movements/new',
    shortcut: 'N M',
    anyOf: ['inventory:manage'],
    keywords: ['adjust', 'damage', 'opening', 'inventory'],
  },
  {
    key: 'new_stock_count',
    label: 'Start stock count',
    path: '/stock-counts/new',
    shortcut: 'N S',
    anyOf: ['inventory:manage'],
    keywords: ['stocktake', 'audit', 'physical', 'count'],
  },
  {
    key: 'new_purchase_order',
    label: '+ Purchase order',
    path: '/purchase-orders/new',
    shortcut: 'N O',
    anyOf: ['purchasing:manage'],
    keywords: ['po', 'order', 'supplier', 'reorder', 'buy'],
  },
  {
    key: 'receive_goods',
    label: 'Receive goods (GRN)',
    path: '/goods-receipts/new',
    shortcut: 'N G',
    anyOf: ['purchasing:manage'],
    keywords: ['grn', 'receipt', 'invoice', 'inward', 'delivery'],
  },
  {
    key: 'new_product',
    label: '+ Product',
    path: '/products/new',
    shortcut: 'N R',
    anyOf: ['catalog:manage'],
    keywords: ['sku', 'item', 'catalogue', 'catalog', 'add'],
  },
  {
    key: 'import_data',
    label: 'Import from Excel or CSV',
    path: '/imports',
    shortcut: 'G I',
    anyOf: ['catalog:manage', 'parties:manage', 'inventory:manage'],
    keywords: ['upload', 'excel', 'csv', 'bulk'],
  },
  {
    key: 'low_stock',
    label: 'Low stock',
    path: '/stock/low',
    shortcut: 'G W',
    anyOf: ['inventory:read'],
    keywords: ['reorder', 'shortage', 'out of stock'],
  },
  {
    key: 'my_follow_ups',
    label: 'My follow-ups',
    path: '/follow-ups',
    shortcut: 'G F',
    anyOf: [],
    keywords: ['today', 'tasks', 'reminders', 'calls'],
  },
];

/**
 * The quick actions a member may use, matching what they typed (every word must
 * appear in the label or keywords); all of them for an empty search.
 */
export function quickActions(access: MemberAccess, query = ''): QuickAction[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  return QUICK_ACTIONS.filter(
    (action) =>
      (action.anyOf.length === 0 ||
        action.anyOf.some((permission) => access.permissions.has(permission))) &&
      words.every((word) =>
        [action.label, ...action.keywords].some((text) => text.toLowerCase().includes(word)),
      ),
  );
}
