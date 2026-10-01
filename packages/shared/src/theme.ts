import { FONTS, type Branding, type Density, type RadiusScale } from './branding.js';
import {
  contrastRatio,
  ensureContrast,
  hexToOklch,
  hexToRgb,
  oklchToHex,
  readableForeground,
  withLightness,
} from './color.js';

/**
 * Turns a business's Branding into every design token the apps use, for light
 * and dark mode. Components only ever use these tokens (CSS custom properties),
 * so changing the branding changes the whole look at runtime.
 *
 * Every text/background pair meets WCAG AA (4.5:1 for text, 3:1 for buttons,
 * input borders, focus rings and chart marks). Brand colours that would fall
 * short are nudged lighter or darker (same hue) and the change is reported in
 * `adjustments`, so a business cannot make the app unreadable.
 */

export const STATUSES = ['success', 'warning', 'danger', 'info'] as const;
export type Status = (typeof STATUSES)[number];

export const CHART_SERIES = 6;

export const COLOR_TOKENS = [
  'background',
  'surface',
  'surface-raised',
  'surface-sunken',
  'overlay',
  'text',
  'text-muted',
  'border',
  'border-strong',
  'focus-ring',
  'primary',
  'primary-hover',
  'primary-active',
  'primary-foreground',
  'primary-subtle',
  'primary-text',
  'accent',
  'accent-hover',
  'accent-foreground',
  'accent-subtle',
  'accent-text',
  ...STATUSES.flatMap(
    (status) => [status, `${status}-foreground`, `${status}-subtle`, `${status}-text`] as const,
  ),
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'chart-6',
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];
export type ColorTokens = Record<ColorToken, string>;

export const SHADOW_TOKENS = ['sm', 'md', 'lg'] as const;
export type ShadowTokens = Record<(typeof SHADOW_TOKENS)[number], string>;

export interface ModeTokens {
  readonly colors: ColorTokens;
  readonly shadows: ShadowTokens;
}

export const PALETTE_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
export type PaletteStep = (typeof PALETTE_STEPS)[number];
export type Ramp = Record<PaletteStep, string>;

/** Lightness of each step of a tonal ramp, in OKLCH. */
const RAMP_LIGHTNESS: Record<PaletteStep, number> = {
  50: 0.975,
  100: 0.94,
  200: 0.88,
  300: 0.8,
  400: 0.71,
  500: 0.62,
  600: 0.54,
  700: 0.46,
  800: 0.38,
  900: 0.3,
  950: 0.22,
};

/** Chroma is strongest in the middle of a ramp; near-white and near-black steps are muted. */
const RAMP_CHROMA: Record<PaletteStep, number> = {
  50: 0.15,
  100: 0.3,
  200: 0.5,
  300: 0.7,
  400: 0.9,
  500: 1,
  600: 1,
  700: 0.9,
  800: 0.75,
  900: 0.6,
  950: 0.45,
};

/** Eleven shades of one hue, from nearly white (50) to nearly black (950). */
export function tonalRamp(hex: string): Ramp {
  const { c, h } = hexToOklch(hex);
  const ramp = {} as Record<PaletteStep, string>;
  for (const step of PALETTE_STEPS) {
    ramp[step] = oklchToHex({ l: RAMP_LIGHTNESS[step], c: c * RAMP_CHROMA[step], h });
  }
  return ramp;
}

export interface ThemeAdjustment {
  readonly mode: 'light' | 'dark';
  readonly token: ColorToken;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

export interface ContrastCheck {
  readonly mode: 'light' | 'dark';
  readonly foreground: ColorToken;
  readonly background: ColorToken;
  readonly ratio: number;
  readonly minimum: number;
  readonly passes: boolean;
}

export interface Theme {
  readonly branding: Branding;
  readonly light: ModeTokens;
  readonly dark: ModeTokens;
  readonly palette: { readonly primary: Ramp; readonly accent: Ramp; readonly neutral: Ramp };
  /** Radius, spacing, sizes and font: the same in light and dark. */
  readonly shape: Readonly<Record<string, string>>;
  readonly adjustments: ThemeAdjustment[];
  readonly checks: ContrastCheck[];
}

/** WCAG AA: body text. */
export const TEXT_CONTRAST = 4.5;
/** WCAG AA: buttons, input borders, focus indicators and chart marks (non-text contrast). */
export const UI_CONTRAST = 3;

/** Base colours for statuses; hue is fixed so "danger" always looks like danger. */
const STATUS_BASE: Record<Status, string> = {
  success: '#15803d',
  warning: '#b45309',
  danger: '#b91c1c',
  info: '#0369a1',
};

/** Hue offsets (degrees from the primary) for chart series 3–6. */
const CHART_HUE_OFFSETS = [150, 210, 270, 330] as const;

const rgbParts = (hex: string) => {
  const { r, g, b } = hexToRgb(hex);
  return [r, g, b].map((channel) => String(Math.round(channel * 255))).join(' ');
};
const translucent = (hex: string, alpha: number) => `rgb(${rgbParts(hex)} / ${String(alpha)})`;

interface ModeSpec {
  readonly mode: 'light' | 'dark';
  /** Lightness of background, surface, raised and sunken surfaces, text, border. */
  readonly background: number;
  readonly surface: number;
  readonly raised: number;
  readonly sunken: number;
  readonly text: number;
  readonly muted: number;
  readonly border: number;
  readonly borderStrong: number;
  readonly subtle: number;
  readonly subtleChroma: number;
  /** Lightness used for status colours and charts in this mode. */
  readonly statusLightness: number | null;
  readonly statusTextLightness: number | null;
  readonly chartLightness: number;
  /** Hover/active move away from the foreground by this much lightness. */
  readonly step: number;
  readonly shadowAlpha: readonly [number, number, number];
}

const LIGHT: ModeSpec = {
  mode: 'light',
  background: 0.975,
  surface: 1,
  raised: 1,
  sunken: 0.95,
  text: 0.21,
  muted: 0.5,
  border: 0.9,
  borderStrong: 0.62,
  subtle: 0.95,
  subtleChroma: 0.04,
  statusLightness: null,
  statusTextLightness: null,
  chartLightness: 0.6,
  step: 0.06,
  shadowAlpha: [0.06, 0.1, 0.14],
};

const DARK: ModeSpec = {
  mode: 'dark',
  background: 0.17,
  surface: 0.21,
  raised: 0.25,
  sunken: 0.14,
  text: 0.96,
  muted: 0.74,
  border: 0.32,
  borderStrong: 0.5,
  subtle: 0.3,
  subtleChroma: 0.06,
  statusLightness: 0.7,
  statusTextLightness: 0.8,
  chartLightness: 0.72,
  step: 0.06,
  shadowAlpha: [0.3, 0.4, 0.5],
};

function deriveMode(
  spec: ModeSpec,
  branding: Branding,
  adjustments: ThemeAdjustment[],
): ModeTokens {
  const primary = hexToOklch(branding.primary);
  const tint = Math.min(primary.c * 0.12, 0.015);
  const neutral = (lightness: number) => oklchToHex({ l: lightness, c: tint, h: primary.h });

  const background = neutral(spec.background);
  const surface = neutral(spec.surface);
  const raised = neutral(spec.raised);
  const sunken = neutral(spec.sunken);
  const surfaces = [background, surface, raised, sunken];

  const record = (token: ColorToken, from: string, to: string, reason: string) => {
    if (from !== to) adjustments.push({ mode: spec.mode, token, from, to, reason });
    return to;
  };
  const direction = spec.mode === 'light' ? 'darkened' : 'lightened';

  /** A brand colour as fill, hover, active, foreground, subtle background and text. */
  const brand = (name: 'primary' | 'accent', hex: string) => {
    const label = name === 'primary' ? 'Primary' : 'Accent';
    const fill = record(
      name,
      hex,
      ensureContrast(hex, [background, surface], UI_CONTRAST),
      `${label} was ${direction} in ${spec.mode} mode so buttons stand out from the page (3:1).`,
    );
    const foreground = readableForeground(fill);
    // Move away from the foreground so hover and pressed states stay readable.
    const away = foreground === '#ffffff' ? -spec.step : spec.step;
    const fillColor = hexToOklch(fill);
    const shade = (amount: number) =>
      ensureContrast(
        oklchToHex({ ...fillColor, l: fillColor.l + amount }),
        [foreground],
        TEXT_CONTRAST,
      );
    const subtle = withLightness(hex, spec.subtle, Math.min(hexToOklch(hex).c, spec.subtleChroma));
    const text = record(
      `${name}-text`,
      hex,
      ensureContrast(hex, [...surfaces, subtle], TEXT_CONTRAST),
      `${label} text was ${direction} in ${spec.mode} mode so links and labels are readable (4.5:1).`,
    );
    return { fill, foreground, hover: shade(away), active: shade(away * 2), subtle, text };
  };

  const p = brand('primary', branding.primary);
  const a = brand('accent', branding.accent);

  const statusColors = {} as Record<string, string>;
  for (const status of STATUSES) {
    const base =
      spec.statusLightness === null
        ? STATUS_BASE[status]
        : withLightness(STATUS_BASE[status], spec.statusLightness);
    const fill = ensureContrast(base, [background, surface], UI_CONTRAST);
    const subtle = withLightness(base, spec.subtle, spec.subtleChroma);
    const textBase =
      spec.statusTextLightness === null
        ? base
        : withLightness(STATUS_BASE[status], spec.statusTextLightness);
    statusColors[status] = fill;
    statusColors[`${status}-foreground`] = readableForeground(fill);
    statusColors[`${status}-subtle`] = subtle;
    statusColors[`${status}-text`] = ensureContrast(textBase, [...surfaces, subtle], TEXT_CONTRAST);
  }

  const chart = (offset: number) =>
    ensureContrast(
      oklchToHex({ l: spec.chartLightness, c: 0.14, h: (primary.h + offset) % 360 }),
      [surface, raised],
      UI_CONTRAST,
    );
  const onSurfaces = (hex: string) => ensureContrast(hex, [surface, raised], UI_CONTRAST);

  const darkest = neutral(0.13);
  const colors = {
    background,
    surface,
    'surface-raised': raised,
    'surface-sunken': sunken,
    overlay: translucent(darkest, spec.mode === 'light' ? 0.5 : 0.7),
    text: ensureContrast(neutral(spec.text), surfaces, TEXT_CONTRAST),
    'text-muted': ensureContrast(neutral(spec.muted), surfaces, TEXT_CONTRAST),
    border: neutral(spec.border),
    'border-strong': ensureContrast(neutral(spec.borderStrong), surfaces, UI_CONTRAST),
    // Primary text already reads at 4.5:1 on every surface, above the 3:1 a focus ring needs.
    'focus-ring': p.text,
    primary: p.fill,
    'primary-hover': p.hover,
    'primary-active': p.active,
    'primary-foreground': p.foreground,
    'primary-subtle': p.subtle,
    'primary-text': p.text,
    accent: a.fill,
    'accent-hover': a.hover,
    'accent-foreground': a.foreground,
    'accent-subtle': a.subtle,
    'accent-text': a.text,
    ...(statusColors as Record<`${Status}${'' | '-foreground' | '-subtle' | '-text'}`, string>),
    'chart-1': onSurfaces(p.fill),
    'chart-2': onSurfaces(a.fill),
    'chart-3': chart(CHART_HUE_OFFSETS[0]),
    'chart-4': chart(CHART_HUE_OFFSETS[1]),
    'chart-5': chart(CHART_HUE_OFFSETS[2]),
    'chart-6': chart(CHART_HUE_OFFSETS[3]),
  } satisfies ColorTokens;

  const [sm, md, lg] = spec.shadowAlpha;
  return {
    colors,
    shadows: {
      sm: `0 1px 2px ${translucent(darkest, sm)}`,
      md: `0 2px 6px ${translucent(darkest, md)}, 0 1px 2px ${translucent(darkest, sm)}`,
      lg: `0 12px 32px ${translucent(darkest, lg)}, 0 2px 6px ${translucent(darkest, md)}`,
    },
  };
}

/** Pairs that must be readable, with the minimum ratio (checked for both modes). */
export const CONTRAST_REQUIREMENTS: readonly {
  readonly foreground: ColorToken;
  readonly background: ColorToken;
  readonly minimum: number;
}[] = [
  ...(['background', 'surface', 'surface-raised', 'surface-sunken'] as const).flatMap(
    (background) =>
      (['text', 'text-muted', 'primary-text', 'accent-text'] as const).map((foreground) => ({
        foreground,
        background,
        minimum: TEXT_CONTRAST,
      })),
  ),
  ...(['background', 'surface'] as const).flatMap((background) =>
    (['primary', 'accent', 'border-strong', 'focus-ring'] as const).map((foreground) => ({
      foreground,
      background,
      minimum: UI_CONTRAST,
    })),
  ),
  ...(['primary', 'primary-hover', 'primary-active'] as const).map((background) => ({
    foreground: 'primary-foreground' as const,
    background,
    minimum: TEXT_CONTRAST,
  })),
  ...(['accent', 'accent-hover'] as const).map((background) => ({
    foreground: 'accent-foreground' as const,
    background,
    minimum: TEXT_CONTRAST,
  })),
  { foreground: 'primary-text', background: 'primary-subtle', minimum: TEXT_CONTRAST },
  { foreground: 'accent-text', background: 'accent-subtle', minimum: TEXT_CONTRAST },
  ...STATUSES.flatMap((status) => [
    { foreground: `${status}-foreground` as const, background: status, minimum: TEXT_CONTRAST },
    {
      foreground: `${status}-text` as const,
      background: `${status}-subtle` as const,
      minimum: TEXT_CONTRAST,
    },
    {
      foreground: `${status}-text` as const,
      background: 'surface' as const,
      minimum: TEXT_CONTRAST,
    },
    { foreground: status, background: 'surface' as const, minimum: UI_CONTRAST },
  ]),
  ...Array.from({ length: CHART_SERIES }, (_, index) => ({
    foreground: `chart-${String(index + 1)}` as ColorToken,
    background: 'surface' as const,
    minimum: UI_CONTRAST,
  })),
];

/** Measures every required pair; `passes` is false where a pair falls short. */
export function checkContrast(mode: 'light' | 'dark', colors: ColorTokens): ContrastCheck[] {
  return CONTRAST_REQUIREMENTS.map(({ foreground, background, minimum }) => {
    const ratio = contrastRatio(colors[foreground], colors[background]);
    return { mode, foreground, background, ratio, minimum, passes: ratio >= minimum };
  });
}

const RADII: Record<RadiusScale, readonly [number, number, number]> = {
  none: [0, 0, 0],
  small: [2, 4, 6],
  medium: [4, 8, 12],
  large: [8, 14, 20],
};

const DENSITY: Record<
  Density,
  {
    space: readonly number[];
    control: number;
    fontSizes: Record<'sm' | 'base' | 'lg' | 'xl' | '2xl', number>;
  }
> = {
  // Larger targets for fingers at the counter.
  comfortable: {
    space: [4, 8, 12, 16, 24, 32, 48],
    control: 44,
    fontSizes: { sm: 14, base: 16, lg: 18, xl: 22, '2xl': 28 },
  },
  compact: {
    space: [2, 4, 8, 12, 16, 24, 32],
    control: 36,
    fontSizes: { sm: 12.5, base: 14, lg: 16, xl: 19, '2xl': 24 },
  },
};

function deriveShape(branding: Branding): Record<string, string> {
  const px = (value: number) => `${String(value)}px`;
  const [sm, md, lg] = RADII[branding.radius];
  const density = DENSITY[branding.density];
  const shape: Record<string, string> = {
    'radius-sm': px(sm),
    'radius-md': px(md),
    'radius-lg': px(lg),
    'radius-full': '9999px',
    'control-height': px(density.control),
    'font-family': FONTS[branding.font].stack,
  };
  density.space.forEach((value, index) => {
    shape[`space-${String(index + 1)}`] = px(value);
  });
  for (const [name, value] of Object.entries(density.fontSizes)) {
    shape[`font-size-${name}`] = px(value);
  }
  return shape;
}

/** Every token for both modes, with any readability adjustments and the contrast report. */
export function deriveTheme(branding: Branding): Theme {
  const adjustments: ThemeAdjustment[] = [];
  const light = deriveMode(LIGHT, branding, adjustments);
  const dark = deriveMode(DARK, branding, adjustments);
  const { c, h } = hexToOklch(branding.primary);
  const neutralBase = oklchToHex({ l: 0.5, c: Math.min(c * 0.12, 0.015), h });
  return {
    branding,
    light,
    dark,
    palette: {
      primary: tonalRamp(branding.primary),
      accent: tonalRamp(branding.accent),
      neutral: tonalRamp(neutralBase),
    },
    shape: deriveShape(branding),
    adjustments,
    checks: [...checkContrast('light', light.colors), ...checkContrast('dark', dark.colors)],
  };
}

/**
 * CSS custom properties for one mode, e.g. { "--color-primary": "#1d4ed8",
 * "--radius-md": "8px", ... }, to set on :root.
 */
export function themeCssVariables(theme: Theme, scheme: 'light' | 'dark'): Record<string, string> {
  const variables: Record<string, string> = {};
  const tokens = theme[scheme];
  for (const [name, value] of Object.entries(tokens.colors)) variables[`--color-${name}`] = value;
  for (const [name, value] of Object.entries(tokens.shadows)) variables[`--shadow-${name}`] = value;
  for (const [ramp, steps] of Object.entries(theme.palette)) {
    for (const [step, value] of Object.entries(steps)) {
      variables[`--palette-${ramp}-${step}`] = value;
    }
  }
  for (const [name, value] of Object.entries(theme.shape)) variables[`--${name}`] = value;
  return variables;
}
