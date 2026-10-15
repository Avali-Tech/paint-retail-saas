import type { NavItem } from '../shell/nav.js';

/** Credit and loyalty sections, after the core sections in the navigation. */
export const CUSTOMER_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'creditApprovals',
    label: 'approvals.title',
    path: '/credit/approvals',
    icon: 'check',
    permission: 'credit:read',
  },
  {
    key: 'creditRequests',
    label: 'credit.requests.title',
    path: '/credit-requests',
    icon: 'check',
    permission: 'credit:read',
  },
  {
    key: 'creditRules',
    label: 'creditRules.title',
    path: '/settings/credit',
    icon: 'settings',
    // Those who can change the rules; others can still open the page to read them.
    permission: 'credit:approve',
  },
  {
    key: 'loyalty',
    label: 'loyaltySettings.title',
    path: '/settings/loyalty',
    icon: 'settings',
    permission: 'loyalty:manage',
  },
  {
    key: 'painterPoints',
    label: 'earnRules.title',
    path: '/settings/painter-points',
    icon: 'settings',
    permission: 'loyalty:manage',
  },
];
