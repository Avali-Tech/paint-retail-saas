import { normalizeHex } from './color.js';

/**
 * A business's look (white-label): a few choices from which the whole theme is
 * derived (see deriveTheme). Stored per organisation and validated with
 * validateBranding, on the server and in the browser alike.
 */
export interface Branding {
  /** Shown in the header, the browser tab and the sign-in screen. */
  readonly appName: string;
  /** Main brand colour, "#rrggbb": buttons, links, the selected tab. */
  readonly primary: string;
  /** Second brand colour, "#rrggbb": highlights and the second chart series. */
  readonly accent: string;
  /** "system" follows the device's light or dark setting. */
  readonly mode: ColorMode;
  readonly radius: RadiusScale;
  /** "compact" fits more on a screen; "comfortable" has larger touch targets. */
  readonly density: Density;
  readonly font: FontKey;
}

export const COLOR_MODES = ['light', 'dark', 'system'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export const RADIUS_SCALES = ['none', 'small', 'medium', 'large'] as const;
export type RadiusScale = (typeof RADIUS_SCALES)[number];

export const DENSITIES = ['compact', 'comfortable'] as const;
export type Density = (typeof DENSITIES)[number];

export interface FontChoice {
  readonly label: string;
  /** CSS font-family list, ending in fallbacks that cover Hindi and Telugu. */
  readonly stack: string;
  /** Google Fonts family to load, or null for fonts already on the device. */
  readonly googleFamily: string | null;
}

const INDIAN_FALLBACKS =
  "'Noto Sans Devanagari', 'Noto Sans Telugu', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Fonts a business can choose: all readable on low-end phones and friendly to Indian scripts. */
export const FONTS = {
  system: { label: 'Device default (fastest)', stack: INDIAN_FALLBACKS, googleFamily: null },
  inter: { label: 'Inter', stack: `Inter, ${INDIAN_FALLBACKS}`, googleFamily: 'Inter' },
  'noto-sans': {
    label: 'Noto Sans',
    stack: `'Noto Sans', ${INDIAN_FALLBACKS}`,
    googleFamily: 'Noto Sans',
  },
  poppins: { label: 'Poppins', stack: `Poppins, ${INDIAN_FALLBACKS}`, googleFamily: 'Poppins' },
  mukta: { label: 'Mukta', stack: `Mukta, ${INDIAN_FALLBACKS}`, googleFamily: 'Mukta' },
} as const satisfies Record<string, FontChoice>;
export type FontKey = keyof typeof FONTS;
export const FONT_KEYS = Object.keys(FONTS) as FontKey[];

/** The product's own look, used until a business sets its branding. */
export const DEFAULT_BRANDING: Branding = {
  appName: 'Paint Retail',
  primary: '#1d4ed8',
  accent: '#b93c0b',
  mode: 'system',
  radius: 'medium',
  density: 'comfortable',
  font: 'system',
};

/** Google Fonts stylesheet for a font, or null when the font needs no download. */
export function fontStylesheetUrl(font: FontKey): string | null {
  const family = FONTS[font].googleFamily;
  if (family === null) return null;
  return `https://fonts.googleapis.com/css2?family=${family.replaceAll(' ', '+')}:wght@400;500;600;700&display=swap`;
}

export interface BrandingIssue {
  /** Field name, matching the API's validation issues. */
  readonly path: string;
  readonly message: string;
}

export type BrandingResult =
  | { readonly ok: true; readonly branding: Branding }
  | { readonly ok: false; readonly issues: BrandingIssue[] };

export const APP_NAME_MAX_LENGTH = 40;

const isOneOf = <T extends string>(options: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (options as readonly string[]).includes(value);

/**
 * Checks branding sent by a client (e.g. the body of PUT /organization/branding)
 * and normalises it: trims the name, lower-cases colours and expands "#abc".
 * Colours that would be hard to read are adjusted later by deriveTheme, never refused.
 */
export function validateBranding(input: unknown): BrandingResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, issues: [{ path: '', message: 'Branding must be an object' }] };
  }
  const value = input as Record<string, unknown>;
  const issues: BrandingIssue[] = [];

  const appName = typeof value.appName === 'string' ? value.appName.trim() : '';
  if (appName.length === 0) issues.push({ path: 'appName', message: 'Enter the app name' });
  else if (appName.length > APP_NAME_MAX_LENGTH) {
    issues.push({
      path: 'appName',
      message: `Use at most ${String(APP_NAME_MAX_LENGTH)} characters`,
    });
  }

  const color = (field: 'primary' | 'accent') => {
    const raw = value[field];
    const hex = typeof raw === 'string' ? normalizeHex(raw) : null;
    if (hex === null) {
      issues.push({ path: field, message: 'Enter a colour like #1d4ed8' });
    }
    return hex;
  };
  const primary = color('primary');
  const accent = color('accent');

  const choice = <T extends string>(field: string, options: readonly T[]): T | null => {
    const option = value[field];
    if (isOneOf(options, option)) return option;
    issues.push({ path: field, message: `Choose one of: ${options.join(', ')}` });
    return null;
  };
  const mode = choice('mode', COLOR_MODES);
  const radius = choice('radius', RADIUS_SCALES);
  const density = choice('density', DENSITIES);
  const font = choice('font', FONT_KEYS);

  if (
    issues.length > 0 ||
    primary === null ||
    accent === null ||
    mode === null ||
    radius === null ||
    density === null ||
    font === null
  ) {
    return { ok: false, issues };
  }
  return { ok: true, branding: { appName, primary, accent, mode, radius, density, font } };
}
