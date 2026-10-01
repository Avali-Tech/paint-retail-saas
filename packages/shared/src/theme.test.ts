import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING, type Branding } from './branding.js';
import { contrastRatio, hexToOklch } from './color.js';
import {
  COLOR_TOKENS,
  CONTRAST_REQUIREMENTS,
  PALETTE_STEPS,
  checkContrast,
  deriveTheme,
  themeCssVariables,
  tonalRamp,
} from './theme.js';

const brand = (overrides: Partial<Branding>): Branding => ({ ...DEFAULT_BRANDING, ...overrides });

/** A spread of brand colours: every hue at several lightness and chroma levels, plus greys. */
function sampleColors(): string[] {
  const colors = ['#ffffff', '#000000', '#808080', '#ffff00', '#00ffff', '#ff00ff', '#ffd700'];
  for (let hue = 0; hue < 360; hue += 30) {
    for (const lightness of [25, 50, 75, 92]) {
      for (const saturation of [40, 100]) {
        const s = saturation / 100;
        const l = lightness / 100;
        const k = (n: number) => (n + hue / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
        const byte = (n: number) =>
          Math.round(f(n) * 255)
            .toString(16)
            .padStart(2, '0');
        colors.push(`#${byte(0)}${byte(8)}${byte(4)}`);
      }
    }
  }
  return colors;
}

describe('deriveTheme', () => {
  it('produces every token for light and dark', () => {
    const theme = deriveTheme(DEFAULT_BRANDING);
    for (const mode of [theme.light, theme.dark]) {
      expect(Object.keys(mode.colors).sort()).toEqual([...COLOR_TOKENS].sort());
      for (const value of Object.values(mode.colors)) {
        expect(value).toMatch(/^(#[0-9a-f]{6}|rgb\(\d+ \d+ \d+ \/ [\d.]+\))$/);
      }
      expect(Object.keys(mode.shadows)).toEqual(['sm', 'md', 'lg']);
    }
    expect(theme.branding).toBe(DEFAULT_BRANDING);
    expect(theme.light.colors.background).not.toBe(theme.dark.colors.background);
  });

  it('keeps a readable default brand exactly as chosen in light mode', () => {
    const theme = deriveTheme(DEFAULT_BRANDING);
    expect(theme.light.colors.primary).toBe(DEFAULT_BRANDING.primary);
    expect(theme.light.colors['primary-foreground']).toBe('#ffffff');
    expect(theme.adjustments.filter((change) => change.mode === 'light')).toEqual([]);
  });

  it('meets WCAG AA for every required pair, whatever colours a business picks', () => {
    const colors = sampleColors();
    expect(colors.length).toBeGreaterThan(90);
    for (const primary of colors) {
      const accent = String(colors[(colors.indexOf(primary) * 7) % colors.length]);
      const theme = deriveTheme(brand({ primary, accent }));
      const failures = theme.checks.filter((check) => !check.passes);
      expect(failures, `primary ${primary}, accent ${accent}`).toEqual([]);
      expect(theme.checks).toHaveLength(CONTRAST_REQUIREMENTS.length * 2);
    }
  });

  it('explains how it changed an unreadable brand colour', () => {
    const theme = deriveTheme(brand({ primary: '#ffd700' }));
    const fill = theme.adjustments.find(
      (change) => change.mode === 'light' && change.token === 'primary',
    );
    expect(fill).toMatchObject({
      from: '#ffd700',
      reason: 'Primary was darkened in light mode so buttons stand out from the page (3:1).',
    });
    expect(contrastRatio(String(fill?.to), theme.light.colors.surface)).toBeGreaterThanOrEqual(3);
    // Same hue: still recognisably the brand's gold.
    expect(hexToOklch(String(fill?.to)).h).toBeCloseTo(hexToOklch('#ffd700').h, -1);
    expect(theme.adjustments).toContainEqual(
      expect.objectContaining({
        mode: 'light',
        token: 'primary-text',
        reason: 'Primary text was darkened in light mode so links and labels are readable (4.5:1).',
      }),
    );
  });

  it('lightens dark brand colours in dark mode', () => {
    const theme = deriveTheme(brand({ accent: '#1e1b4b' }));
    expect(theme.adjustments).toContainEqual(
      expect.objectContaining({
        mode: 'dark',
        token: 'accent',
        reason: 'Accent was lightened in dark mode so buttons stand out from the page (3:1).',
      }),
    );
  });

  it('uses dark text on light brand colours and keeps hover states readable', () => {
    const theme = deriveTheme(brand({ primary: '#fbbf24' }));
    const { colors } = theme.dark;
    expect(colors['primary-foreground']).toBe('#0b0f19');
    expect(hexToOklch(colors['primary-hover']).l).toBeGreaterThan(hexToOklch(colors.primary).l);
    expect(contrastRatio(colors['primary-foreground'], colors['primary-active'])).toBeGreaterThan(
      4.5,
    );
  });

  it('tints the neutrals with the brand hue, but only slightly', () => {
    const { colors } = deriveTheme(brand({ primary: '#16a34a' })).light;
    const background = hexToOklch(colors.background);
    expect(background.c).toBeGreaterThan(0.001);
    expect(background.c).toBeLessThan(0.02);
  });

  it('sets radius, density and font', () => {
    const roomy = deriveTheme(brand({ radius: 'large', density: 'comfortable', font: 'mukta' }));
    expect(roomy.shape).toMatchObject({
      'radius-md': '14px',
      'radius-full': '9999px',
      'control-height': '44px',
      'space-1': '4px',
      'space-7': '48px',
      'font-size-base': '16px',
      'font-size-2xl': '28px',
    });
    expect(roomy.shape['font-family']).toMatch(/^Mukta, /);
    const tight = deriveTheme(brand({ radius: 'none', density: 'compact' }));
    expect(tight.shape).toMatchObject({
      'radius-lg': '0px',
      'control-height': '36px',
      'font-size-sm': '12.5px',
    });
    expect(deriveTheme(brand({ radius: 'small' })).shape['radius-sm']).toBe('2px');
  });
});

describe('tonalRamp', () => {
  it('runs from nearly white to nearly black in the same hue', () => {
    const ramp = tonalRamp('#1d4ed8');
    expect(Object.keys(ramp).map(Number)).toEqual([...PALETTE_STEPS]);
    const lightness = PALETTE_STEPS.map((step) => hexToOklch(ramp[step]).l);
    expect(lightness).toEqual([...lightness].sort((a, b) => b - a));
    expect(hexToOklch(ramp[500]).h).toBeCloseTo(hexToOklch('#1d4ed8').h, -1);
  });
});

describe('checkContrast', () => {
  it('reports pairs that fall short', () => {
    const { colors } = deriveTheme(DEFAULT_BRANDING).light;
    const broken = checkContrast('light', { ...colors, text: colors.background });
    expect(broken.filter((check) => !check.passes)).toContainEqual(
      expect.objectContaining({ foreground: 'text', background: 'background', ratio: 1 }),
    );
  });
});

describe('themeCssVariables', () => {
  it('names every token as a CSS custom property', () => {
    const theme = deriveTheme(DEFAULT_BRANDING);
    const light = themeCssVariables(theme, 'light');
    expect(light['--color-primary']).toBe(theme.light.colors.primary);
    expect(light['--shadow-md']).toBe(theme.light.shadows.md);
    expect(light['--palette-primary-500']).toBe(theme.palette.primary[500]);
    expect(light['--palette-neutral-950']).toBe(theme.palette.neutral[950]);
    expect(light['--radius-md']).toBe('8px');
    expect(light['--font-family']).toBe(theme.shape['font-family']);
    const dark = themeCssVariables(theme, 'dark');
    expect(dark['--color-background']).toBe(theme.dark.colors.background);
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });
});
