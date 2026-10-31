import type { NavItem } from '../shell/nav.js';

/** Settings → Billing (the subscription); the page itself is for the owner (owners and admins see the entry). */
export const BILLING_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'billing',
    section: 'settings',
    group: 'money',
    order: 20,
    label: 'subscription.nav',
    path: '/settings/billing',
    permission: 'organization:manage',
    // Paying for the plan.
    owns: ['/billing'],
  },
];
