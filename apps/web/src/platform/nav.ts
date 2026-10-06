import type { MessageKey } from '../i18n/i18n.js';

export interface PlatformNavItem {
  readonly label: MessageKey;
  readonly path: string;
}

/**
 * The console's sections. There is no operators screen: the API creates the
 * first operator once (POST /platform/bootstrap) and has no routes to manage others.
 */
export const PLATFORM_NAV_ITEMS: readonly PlatformNavItem[] = [
  { label: 'platform.tenants.title', path: '/platform/tenants' },
  { label: 'platform.support.title', path: '/platform/support' },
  { label: 'platform.log.title', path: '/platform/access-log' },
];
