import { deriveTheme, type Branding, type Theme } from '@paint/shared';
import {
  createContext,
  use,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { applyTheme, resolveScheme, type ColorScheme } from './apply-theme.js';

export interface ThemeContextValue {
  readonly theme: Theme;
  /** The scheme on screen now (resolved from "system" when needed). */
  readonly scheme: ColorScheme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribeToScheme(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

/** True while the device is set to dark mode; updates when the user changes it. */
export function usePrefersDark(): boolean {
  return useSyncExternalStore(subscribeToScheme, () => window.matchMedia(DARK_QUERY).matches);
}

export interface ThemeProviderProps {
  readonly branding: Branding;
  readonly children: ReactNode;
}

/**
 * Derives the full theme from a business's branding and applies it to the page.
 * Pass new branding and the whole app restyles at once, without a reload.
 */
export function ThemeProvider({ branding, children }: ThemeProviderProps) {
  const theme = useMemo(() => deriveTheme(branding), [branding]);
  const prefersDark = usePrefersDark();
  const scheme = resolveScheme(branding.mode, prefersDark);
  useLayoutEffect(() => {
    applyTheme(theme, scheme);
  }, [theme, scheme]);
  const value = useMemo(() => ({ theme, scheme }), [theme, scheme]);
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

/** The theme in use. Must be inside ThemeProvider. */
export function useTheme(): ThemeContextValue {
  const value = use(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}
