import { RECEIVABLES_PERMISSION } from '@paint/shared';
import type { NavItem } from '../shell/nav.js';

/** What customers owe and who to chase, after payments in the navigation. */
export const RECEIVABLES_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'receivables',
    label: 'receivables.nav',
    path: '/receivables',
    icon: 'calendar',
    permission: RECEIVABLES_PERMISSION,
  },
  {
    key: 'collections',
    label: 'collections.nav',
    path: '/collections',
    icon: 'bell',
    permission: RECEIVABLES_PERMISSION,
  },
];
