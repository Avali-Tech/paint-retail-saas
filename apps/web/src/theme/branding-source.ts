import { DEFAULT_BRANDING, validateBranding, type Branding } from '@paint/shared';
import type { ApiClient } from '../api/client.js';
import { ApiError } from '../api/errors.js';

/**
 * Where a business's branding comes from. The app only talks to this
 * interface, so moving from the on-device override to the server is one line
 * in services.ts (localBrandingSource -> apiBrandingSource).
 */
export interface BrandingSource {
  /** The last known branding, instantly and offline, so the first paint is already on brand. */
  cached(): Branding;
  load(): Promise<Branding>;
  save(branding: Branding): Promise<Branding>;
  /** Back to the product's default look. */
  reset(): Promise<Branding>;
}

export const BRANDING_KEY = 'paint.branding';

function readCache(storage: Storage): Branding {
  try {
    const result = validateBranding(JSON.parse(storage.getItem(BRANDING_KEY) ?? 'null'));
    return result.ok ? result.branding : DEFAULT_BRANDING;
  } catch {
    return DEFAULT_BRANDING;
  }
}

/** Branding kept on this device only (until GET/PUT /organization/branding exists). */
export function localBrandingSource(storage: Storage): BrandingSource {
  return {
    cached: () => readCache(storage),
    load: () => Promise.resolve(readCache(storage)),
    save: (branding) => {
      storage.setItem(BRANDING_KEY, JSON.stringify(branding));
      return Promise.resolve(branding);
    },
    reset: () => {
      storage.removeItem(BRANDING_KEY);
      return Promise.resolve(DEFAULT_BRANDING);
    },
  };
}

interface BrandingResponse {
  readonly branding: unknown;
}

/**
 * Branding stored per business on the server (proposed contract):
 *   GET /organization/branding -> { branding }   (any member; 404 = not set)
 *   PUT /organization/branding  { ...branding } -> { branding, adjustments }  (organization:manage)
 * The answer is cached on the device for the next start.
 */
export function apiBrandingSource(api: ApiClient, storage: Storage): BrandingSource {
  const remember = (value: unknown) => {
    const result = validateBranding(value);
    const branding = result.ok ? result.branding : DEFAULT_BRANDING;
    storage.setItem(BRANDING_KEY, JSON.stringify(branding));
    return branding;
  };
  return {
    cached: () => readCache(storage),
    load: async () => {
      try {
        return remember((await api.get<BrandingResponse>('/organization/branding')).branding);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return remember(DEFAULT_BRANDING);
        throw error;
      }
    },
    save: async (branding) =>
      remember((await api.put<BrandingResponse>('/organization/branding', branding)).branding),
    reset: async () =>
      remember(
        (await api.put<BrandingResponse>('/organization/branding', DEFAULT_BRANDING)).branding,
      ),
  };
}
