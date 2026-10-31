import type { AnyOf } from '../lib/guard.js';
import type { NavItem } from '../shell/nav.js';

/** Products, parties and opening stock: whoever may change any of them may import it. */
export const IMPORT_PERMISSIONS: AnyOf = ['catalog:manage', 'parties:manage', 'inventory:manage'];

/** Settings → Import data. */
export const IMPORT_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'imports',
    section: 'settings',
    group: 'data',
    order: 10,
    label: 'imports.title',
    path: '/imports',
    permission: IMPORT_PERMISSIONS,
  },
];
