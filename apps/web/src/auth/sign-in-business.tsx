import { DEFAULT_BRANDING, SIGN_IN_BUSINESS_PARAM } from '@paint/shared';
import { createContext, use, useEffect, useLayoutEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { PublicBranding } from '../api/types.js';
import { useServices } from '../app/services.js';
import { useBranding } from '../theme/BrandingProvider.js';
import { useIdentity } from '../theme/IdentityProvider.js';

/**
 * A branded sign-in page: `/sign-in?b=<slug>` wears that business's name, logo and
 * colours before anyone signs in (GET /public/branding/:slug), and the plain
 * `/sign-in` the last business remembered on this device. A future
 * `<slug>.<domain>` address would hand its slug in exactly where the `b`
 * parameter is read here.
 *
 * `plain` keeps the product's own look: support views (whose session-fixation
 * protection must not be undone by a crafted link) and a refused support link.
 */
export function useSignInBusiness(plain: boolean): {
  /** The business the page shows, so the business chooser can offer it first. */
  readonly slug: string | null;
  /** The link named a business that does not exist (or is suspended). */
  readonly unknown: boolean;
} {
  const { signInBusiness } = useServices();
  const { preview } = useBranding();
  const { previewLogo } = useIdentity();
  const [params] = useSearchParams();
  const requested = plain ? null : params.get(SIGN_IN_BUSINESS_PARAM);
  const [remembered] = useState(() => (plain ? null : signInBusiness.remembered()));
  const slug = requested ?? remembered?.slug ?? null;
  // The remembered business's page shows at once, before the server answers.
  const [page, setPage] = useState<PublicBranding | null>(() =>
    requested === null ? (remembered?.page ?? null) : null,
  );
  const [unknown, setUnknown] = useState(false);

  useEffect(() => {
    if (slug === null) return;
    signInBusiness.lookup(slug).then(
      (found) => {
        setPage(found);
        setUnknown(found === null && requested !== null);
      },
      () => {
        // Offline or the server is down: keep what shows; signing in works regardless.
      },
    );
  }, [signInBusiness, slug, requested]);

  // Turning plain (a support link refused) drops whatever business was showing.
  const shown = plain ? null : page;
  const unknownShown = !plain && unknown;
  useLayoutEffect(() => {
    if (unknownShown) {
      preview(DEFAULT_BRANDING);
      previewLogo(null);
    } else if (shown !== null) {
      preview(shown.branding);
      previewLogo(shown.logoUrl);
    }
    return () => {
      preview(null);
      previewLogo(undefined);
    };
  }, [shown, unknownShown, preview, previewLogo]);

  return { slug: shown?.slug ?? null, unknown: unknownShown };
}

/** The business a branded sign-in page is for, so the business chooser offers it first. */
export const SignInBusinessContext = createContext<string | null>(null);

export function usePreferredBusiness(): string | null {
  return use(SignInBusinessContext);
}
