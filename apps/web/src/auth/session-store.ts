import type { SessionGrant } from '../api/types.js';

/** Why a session ended; 'support-rejected': a support view link carried someone's ordinary session. */
export type SessionEndReason = 'signed-out' | 'expired' | 'support-rejected';

export interface SessionState {
  readonly session: SessionGrant | null;
  /** Why the last session ended, to explain it on the sign-in screen. */
  readonly ended: SessionEndReason | null;
}

export interface SessionStore {
  readonly getState: () => SessionState;
  /** The bearer token, or null when signed out or the session has run out. */
  readonly getToken: () => string | null;
  readonly start: (grant: SessionGrant) => void;
  readonly end: (reason: SessionEndReason) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export const SESSION_KEY = 'paint.session';
/** Why the last session ended, kept so a reload of the sign-in screen still explains it. */
export const ENDED_KEY = 'paint.session.ended';

const REASONS: readonly SessionEndReason[] = ['signed-out', 'expired', 'support-rejected'];

function readEnded(storage: Storage): SessionEndReason | null {
  const value = storage.getItem(ENDED_KEY);
  return REASONS.find((reason) => reason === value) ?? null;
}

function readGrant(storage: Storage): SessionGrant | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(SESSION_KEY) ?? 'null');
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
    // Unreadable: treat as signed out.
  }
  return null;
}

/**
 * Keeps the session token in localStorage so a refresh or reopening the PWA
 * stays signed in, until the session expires or the user signs out. Other tabs
 * follow along through the storage event.
 */
export function createSessionStore(
  storage: Storage,
  now: () => number = Date.now,
  win: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): SessionStore {
  const listeners = new Set<() => void>();
  const saved = readGrant(storage);
  let state: SessionState = { session: saved, ended: saved ? null : readEnded(storage) };

  const set = (next: SessionState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const isExpired = (grant: SessionGrant) => Date.parse(grant.expiresAt) <= now();

  const getState = () => {
    if (state.session && isExpired(state.session)) {
      storage.removeItem(SESSION_KEY);
      storage.setItem(ENDED_KEY, 'expired');
      state = { session: null, ended: 'expired' };
    }
    return state;
  };

  return {
    getState,
    getToken: () => getState().session?.token ?? null,
    start: (grant) => {
      storage.setItem(SESSION_KEY, JSON.stringify(grant));
      storage.removeItem(ENDED_KEY);
      set({ session: grant, ended: null });
    },
    end: (reason) => {
      storage.removeItem(SESSION_KEY);
      // A request may find the session gone just before the page reloads (a background
      // poll, then a refresh): the sign-in screen after the reload still says why.
      storage.setItem(ENDED_KEY, reason);
      set({ session: null, ended: reason });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      const onStorage = (event: StorageEvent) => {
        if (event.key !== SESSION_KEY) return;
        const grant = readGrant(storage);
        set({ session: grant, ended: grant ? null : 'signed-out' });
      };
      win.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(listener);
        win.removeEventListener('storage', onStorage);
      };
    },
  };
}
