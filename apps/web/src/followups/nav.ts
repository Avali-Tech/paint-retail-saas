import type { AnyOf } from '../lib/guard.js';
import type { NavItem } from '../shell/nav.js';

/** Activities are about parties, leads, opportunities and projects: seeing any of them opens timelines. */
export const TIMELINE_PERMISSIONS: AnyOf = ['parties:read', 'leads:read', 'projects:read'];

/** Follow-ups, after the core sections in the navigation. */
export const FOLLOW_UP_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'followUps',
    label: 'followUps.nav',
    path: '/follow-ups',
    icon: 'calendar',
    // Everyone may open their own follow-ups; they are on these records.
    permission: TIMELINE_PERMISSIONS,
  },
];
