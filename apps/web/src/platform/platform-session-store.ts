import type { SessionEndReason } from '../auth/session-store.js';
import type { PlatformSession } from './platform-api.js';

export interface PlatformSessionState {
  readonly session: PlatformSession | null;
  readonly ended: SessionEndReason | null;
}

export interface PlatformSessionStore {
  readonly getState: () => PlatformSessionState;
  readonly getToken: () => string | null;
  readonly start: (session: PlatformSession) => void;
  readonly end: (reason: SessionEndReason) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Its own key, never the business session's ("paint.session"): an operator's
 * token and a business member's token never stand in for each other.
 */
export const PLATFORM_SESSION_KEY = 'paint.platform-session';

function readSession(storage: Storage): PlatformSession | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(PLATFORM_SESSION_KEY) ?? 'null');
    if (
      typeof value === 'object' &&
      value !== null &&
      'token' in value &&
      'expiresAt' in value &&
      typeof value.token === 'string' &&
      typeof value.expiresAt === 'string'
    ) {
      return { token: value.token, expiresAt: value.expiresAt };
    }
  } catch {
    // Unreadable: signed out.
  }
  return null;
}

/** The operator's session on this device, shared by the console's tabs, until it expires. */
export function createPlatformSessionStore(
  storage: Storage,
  now: () => number = Date.now,
  win: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): PlatformSessionStore {
  const listeners = new Set<() => void>();
  let state: PlatformSessionState = { session: readSession(storage), ended: null };

  const set = (next: PlatformSessionState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const getState = () => {
    if (state.session && Date.parse(state.session.expiresAt) <= now()) {
      storage.removeItem(PLATFORM_SESSION_KEY);
      state = { session: null, ended: 'expired' };
    }
    return state;
  };

  return {
    getState,
    getToken: () => getState().session?.token ?? null,
    start: (session) => {
      storage.setItem(PLATFORM_SESSION_KEY, JSON.stringify(session));
      set({ session, ended: null });
    },
    end: (reason) => {
      storage.removeItem(PLATFORM_SESSION_KEY);
      set({ session: null, ended: reason });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      const onStorage = (event: StorageEvent) => {
        if (event.key !== PLATFORM_SESSION_KEY) return;
        const session = readSession(storage);
        set({ session, ended: session ? null : 'signed-out' });
      };
      win.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(listener);
        win.removeEventListener('storage', onStorage);
      };
    },
  };
}
