import { BRAND_PROFITABILITY_PERMISSION } from '@paint/shared';
import type { AnyOf } from '../lib/guard.js';
import type { NavItem } from '../shell/nav.js';

/** Each report needs its own permission (GET /reports lists those the member may run). */
export const REPORT_PERMISSIONS: AnyOf = [
  'inventory:read',
  'purchasing:read',
  'leads:read',
  'projects:read',
  'sales:read',
  BRAND_PROFITABILITY_PERMISSION,
];

/** Reports, then brand profitability. */
export const REPORT_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'reports',
    section: 'reports',
    order: 10,
    label: 'reports.title',
    path: '/reports',
    permission: REPORT_PERMISSIONS,
  },
  {
    key: 'brandProfitability',
    section: 'reports',
    order: 20,
    label: 'brandProfitability.nav',
    path: '/reports/brand-profitability',
    permission: BRAND_PROFITABILITY_PERMISSION,
    alsoNeeds: 'costs:read',
  },
];
