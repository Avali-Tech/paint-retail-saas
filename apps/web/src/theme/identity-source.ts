import { buildUrl, type ApiClient } from '../api/client.js';
import type { LogoView, OrganizationIdentity } from '../api/types.js';
import type { SignInBusinessSource } from './sign-in-business.js';

/**
 * The signed-in business's sign-in link name (slug) and logo, from the server,
 * with the last answer kept on the device so the header shows the logo at once.
 */
export interface IdentitySource {
  /** The last known identity, instantly and offline; null before the first. */
  cached(): OrganizationIdentity | null;
  /** GET /organization/identity (any member). */
  load(): Promise<OrganizationIdentity>;
  /** PUT /organization/slug (organization:manage). */
  saveSlug(slug: string): Promise<OrganizationIdentity>;
  /** POST /organization/logo, multipart (organization:manage). */
  uploadLogo(file: File): Promise<OrganizationIdentity>;
  /** DELETE /organization/logo (organization:manage). */
  removeLogo(): Promise<OrganizationIdentity>;
  /** An address on the API (a logo's `url`) as the browser loads it, e.g. "/api/public/…". */
  assetUrl(path: string): string;
}

export const IDENTITY_KEY = 'paint.identity';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** An identity as the API (or the device's copy) gives it, checked; null when it is not one. */
export function readIdentity(value: unknown): OrganizationIdentity | null {
  if (!isRecord(value) || typeof value.slug !== 'string') return null;
  const { logo } = value;
  return {
    slug: value.slug,
    logo: isRecord(logo) && typeof logo.url === 'string' ? (logo as unknown as LogoView) : null,
  };
}

export function apiIdentitySource(
  api: ApiClient,
  storage: Storage,
  apiBaseUrl: string,
  signInBusiness: SignInBusinessSource,
): IdentitySource {
  /** Keeps the answer on the device, and its business as the one this device signs in to. */
  const remember = (answer: unknown): OrganizationIdentity => {
    const identity = readIdentity(answer);
    if (identity === null) throw new Error('The server sent an identity the app cannot read');
    storage.setItem(IDENTITY_KEY, JSON.stringify(identity));
    signInBusiness.remember(identity.slug);
    return identity;
  };
  return {
    cached: () => {
      try {
        return readIdentity(JSON.parse(storage.getItem(IDENTITY_KEY) ?? 'null'));
      } catch {
        return null;
      }
    },
    load: async () => remember(await api.get<unknown>('/organization/identity')),
    saveSlug: async (slug) => remember(await api.put<unknown>('/organization/slug', { slug })),
    uploadLogo: async (file) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return remember(await api.upload<unknown>('/organization/logo', form));
    },
    removeLogo: async () => remember(await api.delete<unknown>('/organization/logo')),
    assetUrl: (path) => buildUrl(apiBaseUrl, path),
  };
}
