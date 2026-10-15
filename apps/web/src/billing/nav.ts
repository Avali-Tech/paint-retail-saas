import type { NavItem } from '../shell/nav.js';

/** Settings → Billing; the page itself is for the owner (owners and admins see the entry). */
export const BILLING_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'billing',
    label: 'subscription.nav',
    path: '/settings/billing',
    icon: 'calendar',
    permission: 'organization:manage',
  },
];
