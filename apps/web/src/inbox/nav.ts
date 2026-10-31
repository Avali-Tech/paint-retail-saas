import type { NavItem } from '../shell/nav.js';

/** Home: the inbox after the dashboard. Every member has one (their follow-ups at least). */
export const INBOX_NAV_ITEMS: readonly NavItem[] = [
  { key: 'inbox', section: 'home', order: 20, label: 'inbox.nav', path: '/inbox' },
];
