import { PERMISSIONS } from '@paint/shared';

/** The role platform support staff act with inside a business: it can look, not change. */
export const SUPPORT_ROLE_KEY = 'support';
export const SUPPORT_ROLE_NAME = 'Platform support';
export const SUPPORT_PERMISSIONS = PERMISSIONS.filter((permission) => permission.endsWith(':read'));
