import { describe, expect, it, vi } from 'vitest';
import { GRANT } from '../test-support/fake-api.js';
import { ENDED_KEY, SESSION_KEY, createSessionStore } from './session-store.js';

describe('createSessionStore', () => {
  it('starts signed out, keeps a started session and tells listeners', () => {
    const store = createSessionStore(localStorage);
    expect(store.getState()).toEqual({ session: null, ended: null });
    expect(store.getToken()).toBeNull();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.start(GRANT);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getToken()).toBe('session-token');
    expect(JSON.parse(String(localStorage.getItem(SESSION_KEY)))).toEqual(GRANT);
    // The same snapshot until something changes.
    expect(store.getState()).toBe(store.getState());
    unsubscribe();
    store.end('signed-out');
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getState()).toEqual({ session: null, ended: 'signed-out' });
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('still says why the last session ended after a reload, until the next one starts', () => {
    const first = createSessionStore(localStorage);
    first.start(GRANT);
    first.end('expired');
    const reloaded = createSessionStore(localStorage);
    expect(reloaded.getState()).toEqual({ session: null, ended: 'expired' });
    reloaded.start(GRANT);
    expect(localStorage.getItem(ENDED_KEY)).toBeNull();
    expect(createSessionStore(localStorage).getState()).toEqual({ session: GRANT, ended: null });
    // A saved session wins over a stale reason; an unknown reason is none.
    localStorage.setItem(ENDED_KEY, 'signed-out');
    expect(createSessionStore(localStorage).getState().ended).toBeNull();
    localStorage.removeItem(SESSION_KEY);
    expect(createSessionStore(localStorage).getState().ended).toBe('signed-out');
    localStorage.setItem(ENDED_KEY, 'bored');
    expect(createSessionStore(localStorage).getState().ended).toBeNull();
  });

  it('picks up a saved session after a reload', () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(GRANT));
    expect(createSessionStore(localStorage).getState().session).toEqual(GRANT);
  });

  it('ignores a damaged or incomplete saved session', () => {
    localStorage.setItem(SESSION_KEY, '{not json');
    expect(createSessionStore(localStorage).getState().session).toBeNull();
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: 'x', expiresAt: 5 }));
    expect(createSessionStore(localStorage).getState().session).toBeNull();
    localStorage.setItem(SESSION_KEY, JSON.stringify('token'));
    expect(createSessionStore(localStorage).getState().session).toBeNull();
  });

  it('drops a session once it has expired', () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const store = createSessionStore(localStorage, () => now);
    store.start({ ...GRANT, expiresAt: '2026-10-02T00:00:00Z' });
    expect(store.getToken()).toBe('session-token');
    now = Date.parse('2026-10-02T00:00:00Z');
    expect(store.getToken()).toBeNull();
    expect(store.getState().ended).toBe('expired');
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(createSessionStore(localStorage).getState().ended).toBe('expired');
  });

  it('follows sign-in and sign-out in other tabs', () => {
    const target = new EventTarget();
    const win = {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    } as Pick<Window, 'addEventListener' | 'removeEventListener'>;
    const store = createSessionStore(localStorage, Date.now, win);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    target.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }));
    expect(listener).not.toHaveBeenCalled();

    localStorage.setItem(SESSION_KEY, JSON.stringify(GRANT));
    target.dispatchEvent(new StorageEvent('storage', { key: SESSION_KEY }));
    expect(store.getState()).toEqual({ session: GRANT, ended: null });

    localStorage.removeItem(SESSION_KEY);
    target.dispatchEvent(new StorageEvent('storage', { key: SESSION_KEY }));
    expect(store.getState()).toEqual({ session: null, ended: 'signed-out' });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    target.dispatchEvent(new StorageEvent('storage', { key: SESSION_KEY }));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
