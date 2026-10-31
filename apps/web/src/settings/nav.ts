import type { NavItem } from '../shell/nav.js';

/** The business settings kept in this folder, and everyone's own account security. */
export const SETTINGS_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'tax',
    section: 'settings',
    group: 'business',
    order: 20,
    label: 'taxSettings.title',
    path: '/settings/tax',
    permission: 'tax:read',
  },
  {
    key: 'invoicePrint',
    section: 'settings',
    group: 'business',
    order: 30,
    label: 'print.settings.title',
    path: '/settings/invoice-print',
    permission: 'organization:manage',
  },
  {
    key: 'tinting',
    section: 'settings',
    group: 'business',
    order: 40,
    label: 'tint.settings.title',
    path: '/settings/tinting',
    permission: 'organization:manage',
  },
  {
    key: 'appearance',
    section: 'settings',
    group: 'business',
    order: 50,
    label: 'nav.appearance',
    path: '/settings/appearance',
    permission: 'organization:manage',
  },
  {
    key: 'stockAlerts',
    section: 'settings',
    group: 'business',
    order: 60,
    label: 'stockAlerts.title',
    path: '/settings/stock-alerts',
    permission: 'organization:manage',
  },
  {
    // What the shop sends customers (P2-M32 templates; MSG-4, MSG-5).
    key: 'messageTemplates',
    section: 'settings',
    group: 'customers',
    order: 40,
    label: 'templates.title',
    path: '/settings/messages',
    permission: 'organization:manage',
  },
  {
    // Every signed-in member manages their own two-factor sign-in.
    key: 'security',
    section: 'settings',
    group: 'access',
    order: 30,
    label: 'shell.security',
    path: '/settings/security',
  },
];
