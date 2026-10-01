import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  ensureContrast,
  hexToOklch,
  hexToRgb,
  isHexColor,
  normalizeHex,
  oklchToHex,
  oklchToRgb,
  parseHex,
  readableForeground,
  relativeLuminance,
  rgbToOklch,
  toHex,
  withLightness,
} from './color.js';

describe('hex colours', () => {
  it('accepts #rgb and #rrggbb in any case', () => {
    expect(isHexColor('#fff')).toBe(true);
    expect(isHexColor('#1D4ED8')).toBe(true);
    expect(isHexColor('1d4ed8')).toBe(false);
    expect(isHexColor('#1d4ed')).toBe(false);
    expect(isHexColor('#ggg')).toBe(false);
  });

  it('parses and prints colours', () => {
    expect(parseHex('#f00')).toEqual({ r: 1, g: 0, b: 0 });
    expect(parseHex('#000080')).toEqual({ r: 0, g: 0, b: 128 / 255 });
    expect(parseHex('red')).toBeNull();
    expect(toHex({ r: 1, g: 0.5, b: 0 })).toBe('#ff8000');
    expect(toHex({ r: 1.2, g: -0.1, b: 0 })).toBe('#ff0000');
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('blue')).toBeNull();
  });

  it('throws for an invalid colour where one is required', () => {
    expect(() => hexToRgb('nope')).toThrow('Invalid hex colour: "nope"');
    expect(() => hexToOklch('#12')).toThrow(TypeError);
    expect(() => relativeLuminance('')).toThrow(TypeError);
  });
});

describe('OKLCH', () => {
  it('converts known colours', () => {
    const white = hexToOklch('#ffffff');
    expect(white.l).toBeCloseTo(1, 4);
    expect(white.c).toBeCloseTo(0, 4);
    expect(hexToOklch('#000000').l).toBeCloseTo(0, 4);
    const red = hexToOklch('#ff0000');
    expect(red.l).toBeCloseTo(0.628, 3);
    expect(red.c).toBeCloseTo(0.2577, 3);
    expect(red.h).toBeCloseTo(29.23, 1);
    // Negative atan2 angles are moved into 0–360.
    expect(hexToOklch('#0000ff').h).toBeCloseTo(264.05, 1);
  });

  it('round-trips sRGB colours', () => {
    for (const hex of ['#1d4ed8', '#c2410c', '#15803d', '#fde047', '#0f172a', '#808080']) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    }
    expect(rgbToOklch({ r: 0, g: 0, b: 0 }).c).toBe(0);
  });

  it('keeps lightness and hue but reduces chroma for colours outside sRGB', () => {
    const vivid = { l: 0.6, c: 0.4, h: 140 };
    const rgb = oklchToRgb(vivid);
    for (const channel of [rgb.r, rgb.g, rgb.b]) {
      expect(channel).toBeGreaterThanOrEqual(-0.001);
      expect(channel).toBeLessThanOrEqual(1.001);
    }
    const mapped = rgbToOklch(rgb);
    expect(mapped.l).toBeCloseTo(0.6, 2);
    expect(mapped.h).toBeCloseTo(140, 0);
    expect(mapped.c).toBeLessThan(0.4);
  });

  it('clamps lightness to 0–1', () => {
    expect(oklchToHex({ l: 1.5, c: 0, h: 0 })).toBe('#ffffff');
    expect(oklchToHex({ l: -1, c: 0, h: 0 })).toBe('#000000');
  });

  it('changes lightness and optionally chroma', () => {
    const lighter = hexToOklch(withLightness('#1d4ed8', 0.8));
    expect(lighter.l).toBeCloseTo(0.8, 2);
    expect(hexToOklch(withLightness('#1d4ed8', 0.5, 0)).c).toBeCloseTo(0, 3);
  });
});

describe('contrast', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#ffffff', '#767676')).toBeCloseTo(4.54, 2);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#020202')).toBeCloseTo(0.000607, 5);
  });

  it('picks the more readable foreground', () => {
    expect(readableForeground('#1d4ed8')).toBe('#ffffff');
    expect(readableForeground('#fde047')).toBe('#0b0f19');
    expect(readableForeground('#fde047', '#fff', '#000')).toBe('#000');
  });

  it('returns a colour unchanged when it already passes', () => {
    expect(ensureContrast('#1d4ed8', ['#ffffff'], 4.5)).toBe('#1d4ed8');
  });

  it('darkens on light backgrounds, keeping the hue, just enough to pass', () => {
    const adjusted = ensureContrast('#fde047', ['#ffffff', '#f8fafc'], 4.5);
    expect(contrastRatio(adjusted, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(adjusted, '#f8fafc')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(adjusted, '#ffffff')).toBeLessThan(5);
    expect(hexToOklch(adjusted).h).toBeCloseTo(hexToOklch('#fde047').h, -1);
  });

  it('lightens on dark backgrounds', () => {
    const adjusted = ensureContrast('#1e3a8a', ['#0f172a'], 4.5);
    expect(hexToOklch(adjusted).l).toBeGreaterThan(hexToOklch('#1e3a8a').l);
    expect(contrastRatio(adjusted, '#0f172a')).toBeGreaterThanOrEqual(4.5);
  });

  it('goes as far as black or white when nothing closer passes', () => {
    expect(ensureContrast('#777777', ['#777777'], 21)).toBe('#000000');
  });
});
