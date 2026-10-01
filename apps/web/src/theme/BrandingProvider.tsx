import type { Branding } from '@paint/shared';
import { ThemeProvider } from '@paint/ui';
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BrandingSource } from './branding-source.js';

export interface BrandingContextValue {
  /** What is on screen: the unsaved preview if there is one, otherwise the saved branding. */
  readonly branding: Branding;
  readonly saved: Branding;
  /** Shows branding across the whole app without saving it; null ends the preview. */
  readonly preview: (branding: Branding | null) => void;
  readonly save: (branding: Branding) => Promise<void>;
  /** Back to the default look; resolves with it. */
  readonly reset: () => Promise<Branding>;
}

const BrandingContext = createContext<BrandingContextValue | null>(null);

/** Loads the business's branding, applies it as the theme and lets the appearance page change it live. */
export function BrandingProvider({
  source,
  children,
}: {
  readonly source: BrandingSource;
  readonly children: ReactNode;
}) {
  const [saved, setSaved] = useState(() => source.cached());
  const [draft, setDraft] = useState<Branding | null>(null);

  useEffect(() => {
    let active = true;
    source.load().then(
      (branding) => {
        if (active) setSaved(branding);
      },
      () => {
        // Keep the cached branding; the next start tries again.
      },
    );
    return () => {
      active = false;
    };
  }, [source]);

  const branding = draft ?? saved;

  useEffect(() => {
    document.title = branding.appName;
  }, [branding.appName]);

  const value = useMemo<BrandingContextValue>(
    () => ({
      branding,
      saved,
      preview: setDraft,
      save: async (next) => {
        setSaved(await source.save(next));
        setDraft(null);
      },
      reset: async () => {
        const restored = await source.reset();
        setSaved(restored);
        setDraft(null);
        return restored;
      },
    }),
    [branding, saved, source],
  );

  return (
    <BrandingContext value={value}>
      <ThemeProvider branding={branding}>{children}</ThemeProvider>
    </BrandingContext>
  );
}

export function useBranding(): BrandingContextValue {
  const value = use(BrandingContext);
  if (!value) throw new Error('useBranding must be used inside <BrandingProvider>');
  return value;
}
