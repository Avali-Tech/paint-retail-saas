import type { NavItem } from '../shell/nav.js';

/** Settings → Support access, for owners and admins (organization:manage). */
export const SUPPORT_ACCESS_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'support-access',
    label: 'supportAccess.nav',
    path: '/settings/support',
    icon: 'lock',
    permission: 'organization:manage',
  },
];
