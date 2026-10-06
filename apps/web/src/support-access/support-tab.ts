import type { SessionGrant } from '../api/types.js';
import { SESSION_KEY } from '../auth/session-store.js';

/**
 * How the platform console opens a business's app read-only: the support
 * session travels in the new tab's address fragment (never sent to a server),
 * and that tab keeps it in its own sessionStorage. So the support session never
 * replaces a business session kept in localStorage, never reaches other tabs,
 * and is gone when the tab closes.
 */
const HANDOFF = '#support=';
/** Marks a tab as a support view, so a refresh keeps using sessionStorage. */
export const SUPPORT_TAB_KEY = 'paint.support-tab';

/** The role the API gives platform support inside a business (apps/api/src/platform/support-role.ts). */
export const SUPPORT_ROLE_KEY = 'support';

/** Whether this tab was opened as a support view (its session must then be support's). */
export function isSupportTab(storage: Storage = window.sessionStorage): boolean {
  return storage.getItem(SUPPORT_TAB_KEY) !== null;
}

/** Stops treating this tab as a support view; the session itself is ended by its store. */
export function leaveSupportTab(storage: Storage = window.sessionStorage): void {
  storage.removeItem(SUPPORT_TAB_KEY);
}

/** The address the console opens in a new tab for a support session. */
export function supportViewUrl(session: SessionGrant): string {
  return `/${HANDOFF}${encodeURIComponent(JSON.stringify(session))}`;
}

function parseHandoff(hash: string): SessionGrant | null {
  if (!hash.startsWith(HANDOFF)) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(hash.slice(HANDOFF.length)));
    if (
      typeof value === 'object' &&
      value !== null &&
      'token' in value &&
      'expiresAt' in value &&
      'organizationId' in value &&
      typeof value.token === 'string' &&
      typeof value.expiresAt === 'string' &&
      typeof value.organizationId === 'string'
    ) {
      return {
        token: value.token,
        expiresAt: value.expiresAt,
        organizationId: value.organizationId,
      };
    }
  } catch {
    // Not a session: ignore it.
  }
  return null;
}

/**
 * The storage this tab keeps its session in: sessionStorage for a support
 * view (taking over a session handed to it in the address, which is then
 * removed from the address and history), otherwise localStorage.
 */
export function sessionStorageFor(win: Window): Storage {
  const handed = parseHandoff(win.location.hash);
  if (handed !== null) {
    win.sessionStorage.setItem(SUPPORT_TAB_KEY, '1');
    win.sessionStorage.setItem(SESSION_KEY, JSON.stringify(handed));
    win.history.replaceState(null, '', win.location.pathname + win.location.search);
  }
  return isSupportTab(win.sessionStorage) ? win.sessionStorage : win.localStorage;
}
