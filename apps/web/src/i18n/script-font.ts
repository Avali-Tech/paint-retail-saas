import type { Locale } from './locale-store.js';

/**
 * A Noto font for the language's script. The theme's font stays first in the stack and
 * draws Latin text; the browser takes Devanagari or Telugu letters from this one, so they
 * look right even on a computer without such fonts. Google Fonts serves only the
 * script's subset (unicode-range), so English pages download nothing.
 */
const SCRIPT_FONTS: Readonly<Record<Locale, string | null>> = {
  en: null,
  hi: 'Noto Sans Devanagari',
  te: 'Noto Sans Telugu',
};

export function scriptFontUrl(locale: Locale): string | null {
  const family = SCRIPT_FONTS[locale];
  if (family === null) return null;
  return `https://fonts.googleapis.com/css2?family=${family.replaceAll(' ', '+')}:wght@400;500;600;700&display=swap`;
}

/** Adds, swaps or removes the stylesheet for the language's script font. */
export function loadScriptFont(locale: Locale, doc: Document = document): void {
  const url = scriptFontUrl(locale);
  const existing = doc.head.querySelector<HTMLLinkElement>('link[data-script-font]');
  if (url === null) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.href = url;
    existing.dataset.scriptFont = locale;
    return;
  }
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  link.dataset.scriptFont = locale;
  doc.head.append(link);
}

/** Marks the page as written in `lang` (screen readers, hyphenation) and loads its font. */
export function applyLanguage(lang: string, locale: Locale, doc: Document): void {
  doc.documentElement.lang = lang;
  loadScriptFont(locale, doc);
}
