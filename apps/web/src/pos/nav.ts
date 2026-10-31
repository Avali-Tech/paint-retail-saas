import type { NavItem } from '../shell/nav.js';

/** The counter sale: the "+ New sale" button at the top of the menu. */
export const POS_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'pos',
    section: 'newSale',
    order: 10,
    label: 'pos.nav',
    path: '/pos',
    permission: 'billing:issue',
  },
];
