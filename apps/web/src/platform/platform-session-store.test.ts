import { describe, expect, it, vi } from 'vitest';
import { SESSION_KEY } from '../auth/session-store.js';
import { PLATFORM_SESSION_KEY, createPlatformSessionStore } from './platform-session-store.js';

const SESSION = { token: 'operator-token', expiresAt: '2099-01-01T00:00:00.000Z' };

describe('createPlatformSessionStore', () => {
  it('keeps the operator session under its own key, never the business session’s', () => {
    const store = createPlatformSessionStore(localStorage);
    expect(store.getState()).toEqual({ session: null, ended: null });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.start(SESSION);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getToken()).toBe('operator-token');
    expect(JSON.parse(String(localStorage.getItem(PLATFORM_SESSION_KEY)))).toEqual(SESSION);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    unsubscribe();
    store.end('signed-out');
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getState()).toEqual({ session: null, ended: 'signed-out' });
    expect(localStorage.getItem(PLATFORM_SESSION_KEY)).toBeNull();
  });

  it('picks up a saved session and ignores a damaged one', () => {
    localStorage.setItem(PLATFORM_SESSION_KEY, JSON.stringify(SESSION));
    expect(createPlatformSessionStore(localStorage).getState().session).toEqual(SESSION);
    localStorage.setItem(PLATFORM_SESSION_KEY, '{not json');
    expect(createPlatformSessionStore(localStorage).getState().session).toBeNull();
    localStorage.setItem(PLATFORM_SESSION_KEY, JSON.stringify({ token: 'x', expiresAt: 5 }));
    expect(createPlatformSessionStore(localStorage).getState().session).toBeNull();
    localStorage.setItem(PLATFORM_SESSION_KEY, JSON.stringify('token'));
    expect(createPlatformSessionStore(localStorage).getState().session).toBeNull();
  });

  it('drops the session once it has expired', () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const store = createPlatformSessionStore(localStorage, () => now);
    store.start({ ...SESSION, expiresAt: '2026-10-01T12:00:00Z' });
    expect(store.getToken()).toBe('operator-token');
    now = Date.parse('2026-10-01T12:00:00Z');
    expect(store.getToken()).toBeNull();
    expect(store.getState().ended).toBe('expired');
    expect(localStorage.getItem(PLATFORM_SESSION_KEY)).toBeNull();
  });

  it('follows the console in other tabs', () => {
    const target = new EventTarget();
    const win = {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    } as Pick<Window, 'addEventListener' | 'removeEventListener'>;
    const store = createPlatformSessionStore(localStorage, Date.now, win);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    // A business signing in elsewhere does not touch the console.
    target.dispatchEvent(new StorageEvent('storage', { key: SESSION_KEY }));
    expect(listener).not.toHaveBeenCalled();

    localStorage.setItem(PLATFORM_SESSION_KEY, JSON.stringify(SESSION));
    target.dispatchEvent(new StorageEvent('storage', { key: PLATFORM_SESSION_KEY }));
    expect(store.getState()).toEqual({ session: SESSION, ended: null });
    localStorage.removeItem(PLATFORM_SESSION_KEY);
    target.dispatchEvent(new StorageEvent('storage', { key: PLATFORM_SESSION_KEY }));
    expect(store.getState()).toEqual({ session: null, ended: 'signed-out' });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    target.dispatchEvent(new StorageEvent('storage', { key: PLATFORM_SESSION_KEY }));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
