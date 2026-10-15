import { RECEIVABLES_PERMISSION } from '@paint/shared';
import type { NavItem } from '../shell/nav.js';

/** What customers owe, after payments in the navigation. */
export const RECEIVABLES_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'receivables',
    label: 'receivables.nav',
    path: '/receivables',
    icon: 'calendar',
    permission: RECEIVABLES_PERMISSION,
  },
];
