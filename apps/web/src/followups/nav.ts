import type { AnyOf } from '../lib/guard.js';
import type { NavItem } from '../shell/nav.js';

/** Activities are about parties, leads, opportunities and projects: seeing any of them opens timelines. */
export const TIMELINE_PERMISSIONS: AnyOf = ['parties:read', 'leads:read', 'projects:read'];

/** Follow-ups, in Customers after projects. */
export const FOLLOW_UP_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'followUps',
    section: 'customers',
    order: 50,
    label: 'followUps.nav',
    path: '/follow-ups',
    // Everyone may open their own follow-ups; they are on these records.
    permission: TIMELINE_PERMISSIONS,
    owns: ['/activities'],
  },
];
