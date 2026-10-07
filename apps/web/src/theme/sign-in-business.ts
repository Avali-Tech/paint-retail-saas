import { normalizeSlug, validateBranding } from '@paint/shared';
import type { ApiClient } from '../api/client.js';
import { ApiError } from '../api/errors.js';
import type { PublicBranding } from '../api/types.js';

/**
 * The business whose sign-in page this device shows: the one in the link
 * (`/sign-in?b=<slug>`), else the last one remembered here (the last link opened,
 * or the business last signed in to).
 */
export interface SignInBusinessSource {
  /** The remembered business, with its page as last seen (null until it has been fetched). */
  remembered(): { readonly slug: string; readonly page: PublicBranding | null } | null;
  /** Remembers a business for the plain sign-in page (keeping its page if it is the same one). */
  remember(slug: string): void;
  /**
   * The business's sign-in page (GET /public/branding/:slug), remembered with it;
   * null when no business uses the link (it is then forgotten if it was remembered).
   */
  lookup(slug: string): Promise<PublicBranding | null>;
}

export const SIGN_IN_BUSINESS_KEY = 'paint.sign-in-business';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** A page as the API (or the device's copy) gives it, checked; null when it is not one. */
export function readPage(value: unknown): PublicBranding | null {
  if (!isRecord(value) || typeof value.slug !== 'string') return null;
  const branding = validateBranding(value.branding);
  if (!branding.ok) return null;
  return {
    slug: value.slug,
    branding: branding.branding,
    logoUrl: typeof value.logoUrl === 'string' ? value.logoUrl : null,
  };
}

export function apiSignInBusinessSource(api: ApiClient, storage: Storage): SignInBusinessSource {
  const read = () => {
    try {
      const value: unknown = JSON.parse(storage.getItem(SIGN_IN_BUSINESS_KEY) ?? 'null');
      if (!isRecord(value) || typeof value.slug !== 'string') return null;
      return { slug: value.slug, page: readPage(value.page) };
    } catch {
      return null;
    }
  };
  const write = (slug: string, page: PublicBranding | null) => {
    storage.setItem(SIGN_IN_BUSINESS_KEY, JSON.stringify({ slug, page }));
  };
  return {
    remembered: read,
    remember: (slug) => {
      const current = read();
      write(slug, current?.slug === slug ? current.page : null);
    },
    lookup: async (slug) => {
      const wanted = normalizeSlug(slug);
      try {
        const page = readPage(
          await api.get<unknown>(`/public/branding/${encodeURIComponent(wanted)}`),
        );
        if (page !== null) write(page.slug, page);
        return page;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        if (read()?.slug === wanted) storage.removeItem(SIGN_IN_BUSINESS_KEY);
        return null;
      }
    },
  };
}
