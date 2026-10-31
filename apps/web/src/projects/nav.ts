import type { NavItem } from '../shell/nav.js';

/** Projects, in Customers after the leads and opportunities they come from. */
export const PROJECT_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'projects',
    section: 'customers',
    order: 40,
    label: 'nav.projects',
    path: '/projects',
    permission: 'projects:read',
  },
];
