import type { AnyOf } from '../lib/guard.js';
import type { NavItem } from '../shell/nav.js';

/**
 * Seeing any kind of record that carries documents opens the documents page:
 * every read permission in DOCUMENT_PERMISSIONS (a test keeps them the same).
 */
export const DOCUMENT_READ_PERMISSIONS: AnyOf = [
  'parties:read',
  'catalog:read',
  'stores:read',
  'purchasing:read',
  'inventory:read',
  'leads:read',
  'projects:read',
  'contracts:read',
];

/** Settings → Documents: the files kept on every kind of record. */
export const DOCUMENT_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'documents',
    section: 'settings',
    group: 'data',
    order: 20,
    label: 'documents.page.nav',
    path: '/documents',
    permission: DOCUMENT_READ_PERMISSIONS,
  },
];
