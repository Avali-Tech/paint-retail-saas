import { PAYMENT_LINK_READ_PERMISSION, PAYMENT_LINK_SETTINGS_PERMISSION } from '@paint/shared';
import type { NavItem } from '../shell/nav.js';

/** The payment links sent to customers (the last tab of Money), and their settings. */
export const PAYMENT_LINK_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'paymentLinks',
    section: 'money',
    order: 60,
    label: 'paymentLinks.title',
    path: '/payment-links',
    permission: PAYMENT_LINK_READ_PERMISSION,
  },
  {
    key: 'paymentLinkSettings',
    section: 'settings',
    group: 'money',
    order: 10,
    label: 'paymentLinkSettings.nav',
    path: '/settings/payment-links',
    permission: PAYMENT_LINK_SETTINGS_PERMISSION,
  },
];
