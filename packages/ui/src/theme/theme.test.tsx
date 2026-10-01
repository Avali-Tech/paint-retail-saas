import { DEFAULT_BRANDING, deriveTheme, type Branding } from '@paint/shared';
import { act, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { applyTheme, loadFont, resolveScheme } from './apply-theme.js';
import { ThemeProvider, usePrefersDark, useTheme } from './ThemeProvider.js';

/** A device whose dark-mode setting the test can flip. */
function fakeDevice(prefersDark: boolean) {
  let matches = prefersDark;
  const listeners = new Set<() => void>();
  window.matchMedia = (media: string) =>
    ({
      get matches() {
        return matches;
      },
      media,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }) as unknown as MediaQueryList;
  return {
    listeners,
    setDark(dark: boolean) {
      matches = dark;
      for (const listener of listeners) listener();
    },
  };
}

const root = () => document.documentElement;
const cssVar = (name: string) => root().style.getPropertyValue(name);

describe('resolveScheme', () => {
  it('follows the device only for "system"', () => {
    expect(resolveScheme('system', true)).toBe('dark');
    expect(resolveScheme('system', false)).toBe('light');
    expect(resolveScheme('light', true)).toBe('light');
    expect(resolveScheme('dark', false)).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('sets every token on <html> and the phone status bar colour', () => {
    const theme = deriveTheme(DEFAULT_BRANDING);
    applyTheme(theme, 'dark');
    expect(cssVar('--color-background')).toBe(theme.dark.colors.background);
    expect(cssVar('--radius-md')).toBe('8px');
    expect(root().dataset.theme).toBe('dark');
    expect(root().dataset.density).toBe('comfortable');
    expect(root().style.colorScheme).toBe('dark');
    const meta = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    expect(meta?.content).toBe(theme.dark.colors.primary);

    // A second call reuses the same meta tag.
    applyTheme(theme, 'light');
    expect(document.head.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    expect(meta?.content).toBe(theme.light.colors.primary);
  });
});

describe('loadFont', () => {
  const fontLinks = () => document.head.querySelectorAll<HTMLLinkElement>('link[data-theme-font]');

  it('adds, swaps and removes the font stylesheet', () => {
    loadFont('inter');
    expect(fontLinks()).toHaveLength(1);
    expect(fontLinks()[0]?.href).toContain('family=Inter:');
    loadFont('inter');
    expect(fontLinks()).toHaveLength(1);
    loadFont('mukta');
    expect(fontLinks()).toHaveLength(1);
    expect(fontLinks()[0]?.href).toContain('family=Mukta:');
    loadFont('system');
    expect(fontLinks()).toHaveLength(0);
    loadFont('system');
    expect(fontLinks()).toHaveLength(0);
  });
});

function SchemeName() {
  const { scheme, theme } = useTheme();
  return (
    <p>
      {scheme} {theme.branding.appName}
    </p>
  );
}

describe('ThemeProvider', () => {
  it('applies branding at once and restyles when it changes', () => {
    fakeDevice(false);
    const { rerender } = render(
      <ThemeProvider branding={{ ...DEFAULT_BRANDING, mode: 'light' }}>
        <SchemeName />
      </ThemeProvider>,
    );
    expect(screen.getByText('light Paint Retail')).toBeInTheDocument();
    expect(cssVar('--color-primary')).toBe(DEFAULT_BRANDING.primary);

    const green: Branding = { ...DEFAULT_BRANDING, primary: '#15803d', mode: 'dark' };
    rerender(
      <ThemeProvider branding={green}>
        <SchemeName />
      </ThemeProvider>,
    );
    expect(screen.getByText('dark Paint Retail')).toBeInTheDocument();
    expect(cssVar('--color-primary')).toBe(deriveTheme(green).dark.colors.primary);
  });

  it('follows the device setting in "system" mode, live', () => {
    const device = fakeDevice(true);
    const { unmount } = render(
      <ThemeProvider branding={DEFAULT_BRANDING}>
        <SchemeName />
      </ThemeProvider>,
    );
    expect(screen.getByText('dark Paint Retail')).toBeInTheDocument();
    act(() => {
      device.setDark(false);
    });
    expect(screen.getByText('light Paint Retail')).toBeInTheDocument();
    expect(root().dataset.theme).toBe('light');
    unmount();
    expect(device.listeners.size).toBe(0);
  });

  it('reports the device setting through usePrefersDark', () => {
    fakeDevice(true);
    expect(renderHook(() => usePrefersDark()).result.current).toBe(true);
  });

  it('refuses useTheme outside the provider', () => {
    expect(() => renderHook(() => useTheme())).toThrow(
      'useTheme must be used inside <ThemeProvider>',
    );
  });
});
