import { afterEach, describe, expect, it } from 'vitest';
import { LOCALE_KEY, isLocale, readLocale, saveLocale } from './locale-store.js';
import { loadScriptFont, scriptFontUrl } from './script-font.js';

const broken = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('full');
  },
};

describe('locale store', () => {
  it('knows the languages the app offers', () => {
    expect(isLocale('hi')).toBe(true);
    expect(isLocale('te')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it('remembers the choice on the device', () => {
    expect(readLocale(localStorage)).toBe('en');
    saveLocale(localStorage, 'te');
    expect(localStorage.getItem(LOCALE_KEY)).toBe('te');
    expect(readLocale(localStorage)).toBe('te');
    localStorage.setItem(LOCALE_KEY, 'klingon');
    expect(readLocale(localStorage)).toBe('en');
  });

  it('copes with storage that cannot be read or written', () => {
    expect(readLocale(broken)).toBe('en');
    expect(() => {
      saveLocale(broken, 'hi');
    }).not.toThrow();
  });
});

describe('script fonts', () => {
  afterEach(() => {
    loadScriptFont('en');
  });

  it('loads a Noto font for Hindi and Telugu only', () => {
    expect(scriptFontUrl('en')).toBeNull();
    expect(scriptFontUrl('hi')).toContain('family=Noto+Sans+Devanagari');
    expect(scriptFontUrl('te')).toContain('family=Noto+Sans+Telugu');
  });

  it('adds, swaps and removes one stylesheet', () => {
    const links = () => document.head.querySelectorAll<HTMLLinkElement>('link[data-script-font]');
    loadScriptFont('en');
    expect(links()).toHaveLength(0);
    loadScriptFont('hi', document);
    expect(links()).toHaveLength(1);
    expect(links()[0]?.rel).toBe('stylesheet');
    loadScriptFont('te');
    expect(links()).toHaveLength(1);
    expect(links()[0]?.href).toContain('Telugu');
    expect(links()[0]?.dataset.scriptFont).toBe('te');
    loadScriptFont('en', document);
    expect(links()).toHaveLength(0);
  });
});
