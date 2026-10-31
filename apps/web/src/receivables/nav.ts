import { RECEIVABLES_PERMISSION } from '@paint/shared';
import type { NavItem } from '../shell/nav.js';

/** What customers owe and who to chase: the first tabs of Money. */
export const RECEIVABLES_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'receivables',
    section: 'money',
    order: 10,
    label: 'receivables.nav',
    path: '/receivables',
    permission: RECEIVABLES_PERMISSION,
  },
  {
    key: 'collections',
    section: 'money',
    order: 20,
    label: 'collections.nav',
    path: '/collections',
    permission: RECEIVABLES_PERMISSION,
  },
];
