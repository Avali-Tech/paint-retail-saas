import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_KEY } from '../auth/session-store.js';
import { GRANT } from '../test-support/fake-api.js';
import { SUPPORT_TAB_KEY, sessionStorageFor, supportViewUrl } from './support-tab.js';

afterEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('support view tabs', () => {
  it('uses localStorage in an ordinary tab', () => {
    window.history.replaceState(null, '', '/dashboard#section');
    expect(sessionStorageFor(window)).toBe(localStorage);
    expect(window.location.hash).toBe('#section');
  });

  it('takes over a support session handed over in the address, then removes it', () => {
    const url = supportViewUrl(GRANT);
    expect(url).toMatch(/^\/#support=/);
    window.history.replaceState(null, '', url);
    expect(sessionStorageFor(window)).toBe(sessionStorage);
    expect(JSON.parse(String(sessionStorage.getItem(SESSION_KEY)))).toEqual(GRANT);
    expect(window.location.hash).toBe('');
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    // A refresh of that tab keeps using its own storage.
    expect(sessionStorageFor(window)).toBe(sessionStorage);
  });

  it('leaves a business session already on the device alone', () => {
    const own = { ...GRANT, token: 'my-own-session' };
    localStorage.setItem(SESSION_KEY, JSON.stringify(own));
    window.history.replaceState(null, '', supportViewUrl(GRANT));
    expect(sessionStorageFor(window)).toBe(sessionStorage);
    expect(JSON.parse(String(localStorage.getItem(SESSION_KEY)))).toEqual(own);
    expect(JSON.parse(String(sessionStorage.getItem(SESSION_KEY)))).toEqual(GRANT);
  });

  it('ignores a damaged or incomplete hand-over', () => {
    window.history.replaceState(null, '', '/#support=%7Bnot-json');
    expect(sessionStorageFor(window)).toBe(localStorage);
    window.history.replaceState(
      null,
      '',
      `/#support=${encodeURIComponent(JSON.stringify({ token: 'x' }))}`,
    );
    expect(sessionStorageFor(window)).toBe(localStorage);
    window.history.replaceState(null, '', `/#support=${encodeURIComponent('"x"')}`);
    expect(sessionStorageFor(window)).toBe(localStorage);
    expect(sessionStorage.getItem(SUPPORT_TAB_KEY)).toBeNull();
  });
});
