import type { NavItem } from '../shell/nav.js';

/** The team section (members, roles and permissions), after the core sections. */
export const TEAM_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'team',
    label: 'team.title',
    path: '/team',
    icon: 'customers',
    // GET /members and GET /roles both need members:read; there is no separate roles:read.
    permission: 'members:read',
  },
];
