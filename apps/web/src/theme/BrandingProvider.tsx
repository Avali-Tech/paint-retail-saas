import type { Branding, ThemeAdjustment } from '@paint/shared';
import { ThemeProvider } from '@paint/ui';
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BrandingSource } from './branding-source.js';

export interface BrandingContextValue {
  /** What is on screen: the unsaved preview if there is one, otherwise the saved branding. */
  readonly branding: Branding;
  readonly saved: Branding;
  /** Shows branding across the whole app without saving it; null ends the preview. */
  readonly preview: (branding: Branding | null) => void;
  /** Saves for the whole business; resolves with the readability adjustments the server made. */
  readonly save: (branding: Branding) => Promise<ThemeAdjustment[]>;
  /** Back to the default look; resolves with it. */
  readonly reset: () => Promise<Branding>;
}

const BrandingContext = createContext<BrandingContextValue | null>(null);

/**
 * Applies the business's branding as the theme and lets the appearance page
 * change it live. Shows the cached branding at once, then loads the business's
 * own whenever a session starts (`sessionKey` changes); signed out, the cache stays.
 */
export function BrandingProvider({
  source,
  sessionKey,
  children,
}: {
  readonly source: BrandingSource;
  readonly sessionKey: string | null;
  readonly children: ReactNode;
}) {
  const [saved, setSaved] = useState(() => source.cached());
  const [draft, setDraft] = useState<Branding | null>(null);

  useEffect(() => {
    if (sessionKey === null) return;
    let active = true;
    source.load().then(
      (branding) => {
        if (active) setSaved(branding);
      },
      () => {
        // Keep the cached branding; the next session tries again.
      },
    );
    return () => {
      active = false;
    };
  }, [source, sessionKey]);

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
        const result = await source.save(next);
        setSaved(result.branding);
        setDraft(null);
        return result.adjustments;
      },
      reset: async () => {
        const restored = await source.reset();
        setSaved(restored.branding);
        setDraft(null);
        return restored.branding;
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
