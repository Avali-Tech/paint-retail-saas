import type { NavItem } from '../shell/nav.js';

/**
 * Customers: the parties list first, the credit queues last. The credit,
 * loyalty and painter-points rules are settings.
 */
export const CUSTOMER_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'customers',
    section: 'customers',
    order: 10,
    label: 'nav.customers',
    path: '/parties',
    permission: 'parties:read',
    // A site account and enrolling in loyalty are about one customer.
    owns: ['/site-accounts', '/loyalty'],
  },
  {
    key: 'creditApprovals',
    section: 'customers',
    order: 70,
    label: 'approvals.title',
    path: '/credit/approvals',
    permission: 'credit:read',
  },
  {
    key: 'creditRequests',
    section: 'customers',
    order: 80,
    label: 'credit.requests.title',
    path: '/credit-requests',
    permission: 'credit:read',
  },
  {
    key: 'creditRules',
    section: 'settings',
    group: 'customers',
    order: 10,
    label: 'creditRules.title',
    path: '/settings/credit',
    // Those who can change the rules; others can still open the page to read them.
    permission: 'credit:approve',
  },
  {
    key: 'loyalty',
    section: 'settings',
    group: 'customers',
    order: 20,
    label: 'loyaltySettings.title',
    path: '/settings/loyalty',
    permission: 'loyalty:manage',
  },
  {
    key: 'painterPoints',
    section: 'settings',
    group: 'customers',
    order: 30,
    label: 'earnRules.title',
    path: '/settings/painter-points',
    permission: 'loyalty:manage',
  },
];
