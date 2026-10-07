/**
 * A business's sign-in link name (`/sign-in?b=sharma-paints`): lower-case letters,
 * digits and single hyphens. Given to each business at sign-up (by the database, from
 * its name) and changeable by its owners. The same rules apply to a future
 * `<slug>.<domain>` address, so the reserved names include likely host names.
 */

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 40;

/**
 * Names no business may take: our own routes and host names, and words that would
 * mislead people about who runs a page. packages/db's generate_organization_slug()
 * never hands these out either (an integration test keeps the two in step).
 */
export const RESERVED_SLUGS: readonly string[] = [
  'about',
  'account',
  'accounts',
  'admin',
  'administrator',
  'api',
  'app',
  'apps',
  'assets',
  'auth',
  'billing',
  'blog',
  'cdn',
  'console',
  'contact',
  'dashboard',
  'demo',
  'dev',
  'docs',
  'email',
  'help',
  'login',
  'logout',
  'mail',
  'new',
  'operator',
  'paint-retail',
  'paintretail',
  'platform',
  'portal',
  'privacy',
  'prod',
  'production',
  'public',
  'root',
  'security',
  'settings',
  'sign-in',
  'sign-out',
  'sign-up',
  'signin',
  'signout',
  'signup',
  'smtp',
  'staging',
  'static',
  'status',
  'support',
  'system',
  'terms',
  'test',
  'www',
];

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why a slug was refused: its length, its characters, or a reserved name. */
export type SlugProblem = 'length' | 'format' | 'reserved';

export type SlugResult =
  | { readonly ok: true; readonly slug: string }
  | { readonly ok: false; readonly problem: SlugProblem; readonly message: string };

const MESSAGES: Record<SlugProblem, string> = {
  length: `Use ${String(SLUG_MIN_LENGTH)} to ${String(SLUG_MAX_LENGTH)} characters`,
  format: 'Use lower-case letters, digits and single hyphens, not at the start or end',
  reserved: 'This name is reserved. Choose another.',
};

/** Trims and lower-cases a slug as typed; the result may still be invalid. */
export function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

/** Checks (after normalizing) a slug a business wants, e.g. the body of PUT /organization/slug. */
export function validateSlug(input: unknown): SlugResult {
  const slug = typeof input === 'string' ? normalizeSlug(input) : '';
  const refuse = (problem: SlugProblem): SlugResult => ({
    ok: false,
    problem,
    message: MESSAGES[problem],
  });
  if (slug.length < SLUG_MIN_LENGTH || slug.length > SLUG_MAX_LENGTH) return refuse('length');
  if (!SLUG_PATTERN.test(slug)) return refuse('format');
  if (RESERVED_SLUGS.includes(slug)) return refuse('reserved');
  return { ok: true, slug };
}

/** The query parameter of a branded sign-in link: `/sign-in?b=<slug>`. */
export const SIGN_IN_BUSINESS_PARAM = 'b';

/** The path of a business's branded sign-in page, e.g. "/sign-in?b=sharma-paints". */
export function signInPath(slug: string): string {
  return `/sign-in?${SIGN_IN_BUSINESS_PARAM}=${encodeURIComponent(slug)}`;
}
