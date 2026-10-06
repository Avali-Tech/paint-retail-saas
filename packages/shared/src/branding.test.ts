import { describe, expect, it } from 'vitest';
import {
  APP_NAME_MAX_LENGTH,
  DEFAULT_BRANDING,
  FONT_KEYS,
  FONTS,
  fontStylesheetUrl,
  validateBranding,
} from './branding.js';

describe('validateBranding', () => {
  it('accepts and normalises valid branding', () => {
    const result = validateBranding({
      ...DEFAULT_BRANDING,
      appName: '  Sri Balaji Paints  ',
      primary: '#ABC',
      accent: '#C2410C',
    });
    expect(result).toEqual({
      ok: true,
      branding: {
        ...DEFAULT_BRANDING,
        appName: 'Sri Balaji Paints',
        primary: '#aabbcc',
        accent: '#c2410c',
      },
    });
  });

  it('accepts the default branding', () => {
    expect(validateBranding(DEFAULT_BRANDING)).toEqual({ ok: true, branding: DEFAULT_BRANDING });
  });

  it('refuses something that is not an object', () => {
    for (const input of [null, 'blue', 7, ['#fff']]) {
      expect(validateBranding(input)).toEqual({
        ok: false,
        issues: [{ path: '', message: 'Branding must be an object' }],
      });
    }
  });

  it('lists every problem by field', () => {
    const result = validateBranding({
      appName: '   ',
      primary: 'blue',
      accent: 42,
      mode: 'dim',
      radius: 'huge',
      density: undefined,
      font: 'Comic Sans',
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        { path: 'appName', message: 'Enter the app name' },
        { path: 'primary', message: 'Enter a colour like #1d4ed8' },
        { path: 'accent', message: 'Enter a colour like #1d4ed8' },
        { path: 'mode', message: 'Choose one of: light, dark, system' },
        { path: 'radius', message: 'Choose one of: none, small, medium, large' },
        { path: 'density', message: 'Choose one of: compact, comfortable' },
        { path: 'font', message: 'Choose one of: system, inter, noto-sans, poppins, mukta' },
      ],
    });
  });

  it('limits the app name length', () => {
    const result = validateBranding({
      ...DEFAULT_BRANDING,
      appName: 'x'.repeat(APP_NAME_MAX_LENGTH + 1),
    });
    expect(result).toEqual({
      ok: false,
      issues: [{ path: 'appName', message: 'Use at most 40 characters' }],
    });
    expect(validateBranding({ ...DEFAULT_BRANDING, appName: 7 })).toMatchObject({ ok: false });
  });
});

describe('fonts', () => {
  it('ends every stack with fallbacks for Hindi and Telugu', () => {
    for (const key of FONT_KEYS) {
      expect(FONTS[key].stack).toContain("'Noto Sans Devanagari', 'Noto Sans Telugu'");
      expect(FONTS[key].stack).toContain("'Nirmala UI', 'Kohinoor Devanagari', 'Kohinoor Telugu'");
      expect(FONTS[key].stack.endsWith('sans-serif')).toBe(true);
    }
  });

  it('builds a Google Fonts URL only for downloadable fonts', () => {
    expect(fontStylesheetUrl('system')).toBeNull();
    expect(fontStylesheetUrl('noto-sans')).toBe(
      'https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700&display=swap',
    );
    expect(fontStylesheetUrl('mukta')).toContain('family=Mukta:');
  });
});
