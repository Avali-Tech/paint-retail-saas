import type { AnyOf } from '../lib/guard.js';
import type { NavItem } from '../shell/nav.js';

/** Products, parties and opening stock: whoever may change any of them may import it. */
export const IMPORT_PERMISSIONS: AnyOf = ['catalog:manage', 'parties:manage', 'inventory:manage'];

/** The import screen, after the core sections in the navigation. */
export const IMPORT_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'imports',
    label: 'imports.title',
    path: '/imports',
    icon: 'products',
    permission: IMPORT_PERMISSIONS,
  },
];
