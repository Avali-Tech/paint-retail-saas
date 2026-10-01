/**
 * Colour maths for themes: hex parsing, OKLCH (a perceptual colour space, so
 * equal steps in lightness look equal) and WCAG 2 contrast ratios.
 * OKLab conversion follows Björn Ottosson's reference implementation.
 */

export interface Rgb {
  /** Each channel 0–1 in sRGB (gamma-encoded). */
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Oklch {
  /** Lightness 0 (black) – 1 (white). */
  readonly l: number;
  /** Chroma (colourfulness), 0 for greys; sRGB colours stay below about 0.37. */
  readonly c: number;
  /** Hue angle in degrees, 0–360. */
  readonly h: number;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** True for "#rgb" or "#rrggbb". */
export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

/** Parses "#rgb" or "#rrggbb" (any case); null when it is neither. */
export function parseHex(value: string): Rgb | null {
  if (!isHexColor(value)) return null;
  const digits =
    value.length === 4 ? value.slice(1).replace(/./g, (digit) => digit + digit) : value.slice(1);
  const channel = (index: number) => parseInt(digits.slice(index, index + 2), 16) / 255;
  return { r: channel(0), g: channel(2), b: channel(4) };
}

/** Lower-case "#rrggbb"; channels outside 0–1 are clamped. */
export function toHex({ r, g, b }: Rgb): string {
  const byte = (channel: number) =>
    Math.round(Math.min(1, Math.max(0, channel)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** Normalises any accepted hex form to lower-case "#rrggbb". */
export function normalizeHex(value: string): string | null {
  const rgb = parseHex(value);
  return rgb ? toHex(rgb) : null;
}

const toLinear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

const toGamma = (channel: number) =>
  channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;

/** Converts sRGB to OKLCH. */
export function rgbToOklch(rgb: Rgb): Oklch {
  const r = toLinear(rgb.r);
  const g = toLinear(rgb.g);
  const b = toLinear(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = (Math.atan2(bb, a) * 180) / Math.PI;
  return { l: lightness, c: Math.hypot(a, bb), h: hue < 0 ? hue + 360 : hue };
}

/** Converts OKLCH to sRGB without clamping; channels may fall outside 0–1. */
function oklchToUnclampedRgb({ l, c, h }: Oklch): Rgb {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);
  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: toGamma(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc),
    g: toGamma(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc),
    b: toGamma(-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc),
  };
}

const EPSILON = 0.0005;
const inGamut = ({ r, g, b }: Rgb) =>
  [r, g, b].every((channel) => channel >= -EPSILON && channel <= 1 + EPSILON);

/**
 * Converts OKLCH to sRGB. Colours outside the sRGB gamut keep their lightness
 * and hue and lose chroma until they fit, so they stay recognisably the same colour.
 */
export function oklchToRgb(color: Oklch): Rgb {
  const l = Math.min(1, Math.max(0, color.l));
  const direct = oklchToUnclampedRgb({ ...color, l });
  if (inGamut(direct)) return direct;
  let low = 0;
  let high = color.c;
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2;
    if (inGamut(oklchToUnclampedRgb({ l, c: middle, h: color.h }))) low = middle;
    else high = middle;
  }
  return oklchToUnclampedRgb({ l, c: low, h: color.h });
}

/** Like parseHex, but throws on an invalid colour (validate input with isHexColor first). */
export function hexToRgb(hex: string): Rgb {
  const rgb = parseHex(hex);
  if (!rgb) throw new TypeError(`Invalid hex colour: "${hex}"`);
  return rgb;
}

/** OKLCH of a hex colour; throws on an invalid one. */
export function hexToOklch(hex: string): Oklch {
  return rgbToOklch(hexToRgb(hex));
}

export function oklchToHex(color: Oklch): string {
  return toHex(oklchToRgb(color));
}

/** WCAG 2 relative luminance of a hex colour, 0 (black) – 1 (white). */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
}

/** WCAG 2 contrast ratio between two colours, 1 – 21. */
export function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Whichever of white or near-black reads better on `background`. */
export function readableForeground(
  background: string,
  light = '#ffffff',
  dark = '#0b0f19',
): string {
  return contrastRatio(background, light) >= contrastRatio(background, dark) ? light : dark;
}

/**
 * The colour closest to `hex` (same hue, as much chroma as fits) whose contrast
 * with every colour in `against` is at least `minimum`. It darkens on light
 * backgrounds and lightens on dark ones. Returns `hex` unchanged when it already passes.
 */
export function ensureContrast(hex: string, against: readonly string[], minimum: number): string {
  const passes = (candidate: string) =>
    against.every((background) => contrastRatio(candidate, background) >= minimum);
  if (passes(hex)) return hex;
  const color = hexToOklch(hex);
  const backgroundLuminance =
    against.reduce((sum, background) => sum + relativeLuminance(background), 0) / against.length;
  const darken = backgroundLuminance > 0.18;
  // Search the lightness between the colour and the extreme (black or white).
  let near = color.l;
  let far = darken ? 0 : 1;
  for (let step = 0; step < 24; step += 1) {
    const middle = (near + far) / 2;
    if (passes(oklchToHex({ ...color, l: middle }))) far = middle;
    else near = middle;
  }
  return oklchToHex({ ...color, l: far });
}

/** Mixes a colour's lightness and chroma toward targets, keeping its hue. */
export function withLightness(hex: string, lightness: number, chroma?: number): string {
  const color = hexToOklch(hex);
  return oklchToHex({ l: lightness, c: chroma ?? color.c, h: color.h });
}
