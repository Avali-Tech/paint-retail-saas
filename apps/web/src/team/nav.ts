import type { NavItem } from '../shell/nav.js';

/** Settings → Team & roles: members, roles and permissions. */
export const TEAM_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'team',
    section: 'settings',
    group: 'access',
    order: 10,
    label: 'nav.teamAndRoles',
    path: '/team',
    // GET /members and GET /roles both need members:read; there is no separate roles:read.
    permission: 'members:read',
  },
];
