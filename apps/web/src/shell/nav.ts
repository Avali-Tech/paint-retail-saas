import type { Permission } from '@paint/shared';
import type { IconName } from '@paint/ui';
import type { MessageKey } from '../i18n/i18n.js';
import { BILLING_NAV_ITEMS } from '../billing/nav.js';
import { BOOKS_NAV_ITEMS } from '../books/nav.js';
import { DOCUMENT_NAV_ITEMS } from '../documents/nav.js';
import { ESTIMATE_NAV_ITEMS } from '../estimator/nav.js';
import { FOLLOW_UP_NAV_ITEMS } from '../followups/nav.js';
import { IMPORT_NAV_ITEMS } from '../imports/nav.js';
import { CRM_NAV_ITEMS } from '../leads/nav.js';
import type { AnyOf } from '../lib/guard.js';
import { ORDER_NAV_ITEMS } from '../orders/nav.js';
import { CUSTOMER_NAV_ITEMS } from '../parties/nav.js';
import { POS_NAV_ITEMS } from '../pos/nav.js';
import { RECEIVABLES_NAV_ITEMS } from '../receivables/nav.js';
import { REPORT_NAV_ITEMS } from '../reports/nav.js';
import { SALES_NAV_ITEMS } from '../sales/nav.js';
import { SETUP_NAV_ITEMS } from '../setup/nav.js';
import { SUPPORT_ACCESS_NAV_ITEMS } from '../support-access/nav.js';
import { TEAM_NAV_ITEMS } from '../team/nav.js';

export interface NavItem {
  readonly key: string;
  readonly label: MessageKey;
  readonly path: string;
  readonly icon: IconName;
  /** Shown only to members holding this permission (or any of these). */
  readonly permission: Permission | AnyOf;
  /** And this one as well, e.g. costs:read for a page about margins. */
  readonly alsoNeeds?: Permission;
}

/** The main sections, in order. Phones show the first four in the bottom bar and the rest under "More". */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'dashboard',
    label: 'nav.dashboard',
    path: '/dashboard',
    icon: 'dashboard',
    permission: 'stores:read',
  },
  ...POS_NAV_ITEMS,
  {
    key: 'customers',
    label: 'nav.customers',
    path: '/parties',
    icon: 'customers',
    permission: 'parties:read',
  },
  {
    key: 'products',
    label: 'nav.products',
    path: '/products',
    icon: 'products',
    permission: 'catalog:read',
  },
  { key: 'stock', label: 'nav.stock', path: '/stock', icon: 'stock', permission: 'inventory:read' },
  {
    key: 'purchasing',
    label: 'nav.purchasing',
    path: '/purchase-orders',
    icon: 'purchasing',
    permission: 'purchasing:read',
  },
  { key: 'leads', label: 'nav.leads', path: '/leads', icon: 'leads', permission: 'leads:read' },
  ...CRM_NAV_ITEMS,
  {
    key: 'projects',
    label: 'nav.projects',
    path: '/projects',
    icon: 'projects',
    permission: 'projects:read',
  },
  {
    key: 'contracts',
    label: 'nav.contracts',
    path: '/contracts',
    icon: 'contracts',
    permission: 'contracts:read',
  },
  // Each feature keeps its own entries in its own file.
  ...ESTIMATE_NAV_ITEMS,
  ...ORDER_NAV_ITEMS,
  ...SALES_NAV_ITEMS,
  ...BOOKS_NAV_ITEMS,
  ...RECEIVABLES_NAV_ITEMS,
  ...FOLLOW_UP_NAV_ITEMS,
  ...DOCUMENT_NAV_ITEMS,
  ...CUSTOMER_NAV_ITEMS,
  ...IMPORT_NAV_ITEMS,
  ...REPORT_NAV_ITEMS,
  ...TEAM_NAV_ITEMS,
  {
    key: 'appearance',
    label: 'nav.appearance',
    path: '/settings/appearance',
    icon: 'settings',
    permission: 'organization:manage',
  },
  {
    key: 'tax',
    label: 'taxSettings.title',
    path: '/settings/tax',
    icon: 'settings',
    permission: 'tax:read',
  },
  {
    key: 'invoicePrint',
    label: 'print.settings.title',
    path: '/settings/invoice-print',
    icon: 'settings',
    permission: 'organization:manage',
  },
  {
    key: 'tinting',
    label: 'tint.settings.title',
    path: '/settings/tinting',
    icon: 'settings',
    permission: 'organization:manage',
  },
  {
    key: 'stockAlerts',
    label: 'stockAlerts.title',
    path: '/settings/stock-alerts',
    icon: 'settings',
    permission: 'organization:manage',
  },
  {
    key: 'paymentLinkSettings',
    label: 'paymentLinkSettings.nav',
    path: '/settings/payment-links',
    icon: 'settings',
    permission: 'organization:manage',
  },
  ...SUPPORT_ACCESS_NAV_ITEMS,
  ...BILLING_NAV_ITEMS,
  ...SETUP_NAV_ITEMS,
];

export const BOTTOM_BAR_SIZE = 4;

/** The sections a member may open. */
export function visibleNav(can: (permission: Permission) => boolean): NavItem[] {
  return NAV_ITEMS.filter(
    (item) =>
      (typeof item.permission === 'string' ? can(item.permission) : item.permission.some(can)) &&
      (item.alsoNeeds === undefined || can(item.alsoNeeds)),
  );
}
