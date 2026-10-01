import {
  fontStylesheetUrl,
  themeCssVariables,
  type ColorMode,
  type FontKey,
  type Theme,
} from '@paint/shared';

export type ColorScheme = 'light' | 'dark';

/** The scheme to show: the business's choice, or the device's for "system". */
export function resolveScheme(mode: ColorMode, prefersDark: boolean): ColorScheme {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

/**
 * Applies a theme to the page: sets every token as a CSS custom property on
 * <html>, tells the browser which scheme is in use (form controls, scrollbars),
 * colours the phone's status bar and loads the chosen font. Instant: no reload.
 */
export function applyTheme(theme: Theme, scheme: ColorScheme, doc: Document = document): void {
  const root = doc.documentElement;
  for (const [name, value] of Object.entries(themeCssVariables(theme, scheme))) {
    root.style.setProperty(name, value);
  }
  root.style.colorScheme = scheme;
  root.dataset.theme = scheme;
  root.dataset.density = theme.branding.density;

  let meta = doc.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = doc.createElement('meta');
    meta.name = 'theme-color';
    doc.head.append(meta);
  }
  meta.content = theme[scheme].colors.primary;

  loadFont(theme.branding.font, doc);
}

/** Adds (or swaps, or removes) the stylesheet for a downloadable font. */
export function loadFont(font: FontKey, doc: Document = document): void {
  const url = fontStylesheetUrl(font);
  const existing = doc.head.querySelector<HTMLLinkElement>('link[data-theme-font]');
  if (url === null) {
    existing?.remove();
    return;
  }
  if (existing) {
    if (existing.href !== url) existing.href = url;
    return;
  }
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  link.dataset.themeFont = font;
  doc.head.append(link);
}
