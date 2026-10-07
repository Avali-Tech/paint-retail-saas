/** How much of the logo's SHA-256 its address carries: enough to change with every new logo. */
export const LOGO_VERSION_LENGTH = 16;

/**
 * The logo's address on the API (public: the sign-in page shows it before anyone
 * signs in). It changes whenever the logo or the slug does, so it can be cached for good.
 */
export function logoUrl(slug: string, sha256: string): string {
  return `/public/branding/${slug}/logo/${sha256.slice(0, LOGO_VERSION_LENGTH)}`;
}
