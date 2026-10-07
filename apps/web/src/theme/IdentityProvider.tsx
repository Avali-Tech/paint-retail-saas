import { createContext, use, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { OrganizationIdentity } from '../api/types.js';
import type { IdentitySource } from './identity-source.js';

export interface IdentityContextValue {
  /** The signed-in business's slug and logo; null until first known on this device. */
  readonly identity: OrganizationIdentity | null;
  /** The logo on screen, as an image address: a sign-in page's business while one shows, else the business's own. */
  readonly logoSrc: string | null;
  /** After saving the slug or the logo. */
  readonly setIdentity: (identity: OrganizationIdentity) => void;
  /** A sign-in page shows its business's logo (an API path, or null for none); undefined ends that. */
  readonly previewLogo: (logoUrl: string | null | undefined) => void;
  /** An API path (a logo's url) as an image address. */
  readonly assetUrl: (path: string) => string;
}

const IdentityContext = createContext<IdentityContextValue | null>(null);

/**
 * Uses the logo as the browser tab's and home-screen icon, or puts the product's own
 * icon back (the index.html links stay; ours come after them, so browsers prefer them).
 */
export function showBrandIcon(doc: Document, src: string | null): void {
  for (const rel of ['icon', 'apple-touch-icon']) {
    doc.head.querySelector(`link[data-brand-icon="${rel}"]`)?.remove();
    if (src !== null) {
      const link = doc.createElement('link');
      link.rel = rel;
      link.href = src;
      link.dataset.brandIcon = rel;
      doc.head.append(link);
    }
  }
}

/**
 * The business's slug and logo: the cached ones at once, then the business's own
 * whenever a session starts (`sessionKey` changes); signed out, the cache stays.
 */
export function IdentityProvider({
  source,
  sessionKey,
  children,
}: {
  readonly source: IdentitySource;
  readonly sessionKey: string | null;
  readonly children: ReactNode;
}) {
  const [identity, setIdentity] = useState(() => source.cached());
  const [preview, setPreview] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (sessionKey === null) return;
    let active = true;
    source.load().then(
      (loaded) => {
        if (active) setIdentity(loaded);
      },
      () => {
        // Keep the cached identity; the next session tries again.
      },
    );
    return () => {
      active = false;
    };
  }, [source, sessionKey]);

  const logoUrl = preview === undefined ? (identity?.logo?.url ?? null) : preview;
  const logoSrc = logoUrl === null ? null : source.assetUrl(logoUrl);

  useEffect(() => {
    showBrandIcon(document, logoSrc);
  }, [logoSrc]);

  const value = useMemo<IdentityContextValue>(
    () => ({
      identity,
      logoSrc,
      setIdentity,
      previewLogo: setPreview,
      assetUrl: (path) => source.assetUrl(path),
    }),
    [identity, logoSrc, source],
  );
  return <IdentityContext value={value}>{children}</IdentityContext>;
}

export function useIdentity(): IdentityContextValue {
  const value = use(IdentityContext);
  if (!value) throw new Error('useIdentity must be used inside <IdentityProvider>');
  return value;
}
