import type { Permission } from '@paint/shared';
import type { MessageKey } from '../i18n/i18n.js';
import { BILLING_NAV_ITEMS } from '../billing/nav.js';
import { BOOKS_NAV_ITEMS } from '../books/nav.js';
import { CATALOG_NAV_ITEMS } from '../catalog/nav.js';
import { CONTRACT_NAV_ITEMS } from '../contracts/nav.js';
import { DASHBOARD_NAV_ITEMS } from '../dashboard/nav.js';
import { DOCUMENT_NAV_ITEMS } from '../documents/nav.js';
import { ESTIMATE_NAV_ITEMS } from '../estimator/nav.js';
import { FOLLOW_UP_NAV_ITEMS } from '../followups/nav.js';
import { IMPORT_NAV_ITEMS } from '../imports/nav.js';
import { CRM_NAV_ITEMS } from '../leads/nav.js';
import type { AnyOf } from '../lib/guard.js';
import { ORDER_NAV_ITEMS } from '../orders/nav.js';
import { CUSTOMER_NAV_ITEMS } from '../parties/nav.js';
import { PAYMENT_LINK_NAV_ITEMS } from '../payment-links/nav.js';
import { POS_NAV_ITEMS } from '../pos/nav.js';
import { PROJECT_NAV_ITEMS } from '../projects/nav.js';
import { PURCHASING_NAV_ITEMS } from '../purchasing/nav.js';
import { RECEIVABLES_NAV_ITEMS } from '../receivables/nav.js';
import { REPORT_NAV_ITEMS } from '../reports/nav.js';
import { SALES_NAV_ITEMS } from '../sales/nav.js';
import { SETTINGS_NAV_ITEMS } from '../settings/nav.js';
import { SETUP_NAV_ITEMS } from '../setup/nav.js';
import { STOCK_NAV_ITEMS } from '../stock/nav.js';
import { SUPPORT_ACCESS_NAV_ITEMS } from '../support-access/nav.js';
import { TEAM_NAV_ITEMS } from '../team/nav.js';

/** The entries of the main menu, top to bottom (docs/mvp-3/navigation-ux.md §5.1). */
export const SECTION_KEYS = [
  'home',
  'newSale',
  'sales',
  'customers',
  'money',
  'stock',
  'buy',
  'reports',
  'settings',
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/** The groups of the Settings page, in order. */
export const SETTINGS_GROUPS = ['business', 'access', 'customers', 'money', 'data'] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

interface BaseNavItem {
  readonly key: string;
  readonly label: MessageKey;
  readonly path: string;
  /** Place among the section's tabs, lowest first. */
  readonly order: number;
  /** Shown only to members holding this permission (or any of these); omitted = everyone. */
  readonly permission?: Permission | AnyOf;
  /** And this one as well, e.g. costs:read for a page about margins. */
  readonly alsoNeeds?: Permission;
  /** Other addresses that belong to this page, e.g. /accounting for the Tally export screens. */
  readonly owns?: readonly string[];
}

/**
 * One page in the menu: a tab of its section. Each feature declares its own in
 * its nav.ts; settings pages also name their group on the Settings page.
 */
export type NavItem =
  | (BaseNavItem & { readonly section: Exclude<SectionKey, 'settings'> })
  | (BaseNavItem & { readonly section: 'settings'; readonly group: SettingsGroup });

/** Every page in the menu. Sections order them; the order here does not matter. */
export const NAV_ITEMS: readonly NavItem[] = [
  ...DASHBOARD_NAV_ITEMS,
  ...POS_NAV_ITEMS,
  ...ESTIMATE_NAV_ITEMS,
  ...ORDER_NAV_ITEMS,
  ...SALES_NAV_ITEMS,
  ...CUSTOMER_NAV_ITEMS,
  ...CRM_NAV_ITEMS,
  ...PROJECT_NAV_ITEMS,
  ...FOLLOW_UP_NAV_ITEMS,
  ...CONTRACT_NAV_ITEMS,
  ...RECEIVABLES_NAV_ITEMS,
  ...BOOKS_NAV_ITEMS,
  ...PAYMENT_LINK_NAV_ITEMS,
  ...CATALOG_NAV_ITEMS,
  ...STOCK_NAV_ITEMS,
  ...PURCHASING_NAV_ITEMS,
  ...REPORT_NAV_ITEMS,
  ...SETUP_NAV_ITEMS,
  ...SETTINGS_NAV_ITEMS,
  ...TEAM_NAV_ITEMS,
  ...SUPPORT_ACCESS_NAV_ITEMS,
  ...BILLING_NAV_ITEMS,
  ...IMPORT_NAV_ITEMS,
  ...DOCUMENT_NAV_ITEMS,
];
