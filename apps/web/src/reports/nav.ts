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

/** Reports, after imports in the navigation. */
export const REPORT_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'reports',
    label: 'reports.title',
    path: '/reports',
    icon: 'dashboard',
    permission: REPORT_PERMISSIONS,
  },
  {
    key: 'brandProfitability',
    label: 'brandProfitability.nav',
    path: '/reports/brand-profitability',
    icon: 'dashboard',
    permission: BRAND_PROFITABILITY_PERMISSION,
  },
];
