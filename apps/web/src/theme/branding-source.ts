import { DEFAULT_BRANDING, validateBranding, type Branding } from '@paint/shared';
import type { ApiClient } from '../api/client.js';
import { ApiError } from '../api/errors.js';
import type { BrandingSaved, BrandingView } from '../api/types.js';

/**
 * Where a business's branding comes from: the server, with the last answer
 * kept on the device so the first paint (even offline) is already on brand.
 */
export interface BrandingSource {
  /** The last known branding, instantly and offline. */
  cached(): Branding;
  /** The business's branding from the server (the default until it sets one). */
  load(): Promise<Branding>;
  /** Saves it for everyone in the business; answers how the theme adjusted it to stay readable. */
  save(branding: Branding): Promise<BrandingSaved>;
  /** Back to the product's default look, for everyone. */
  reset(): Promise<BrandingSaved>;
}

/** The device's copy of the last branding seen, read before the app starts. */
export const BRANDING_KEY = 'paint.branding';

function readCache(storage: Storage): Branding {
  try {
    const result = validateBranding(JSON.parse(storage.getItem(BRANDING_KEY) ?? 'null'));
    return result.ok ? result.branding : DEFAULT_BRANDING;
  } catch {
    return DEFAULT_BRANDING;
  }
}

/**
 * Branding stored per business on the server:
 *   GET /organization/branding -> { branding, updatedAt }   (any member; 404 = not set)
 *   PUT /organization/branding  { ...branding } -> { branding, adjustments }  (organization:manage)
 * Every answer is checked with validateBranding and cached on the device.
 */
export function apiBrandingSource(api: ApiClient, storage: Storage): BrandingSource {
  const remember = (value: unknown) => {
    const result = validateBranding(value);
    const branding = result.ok ? result.branding : DEFAULT_BRANDING;
    storage.setItem(BRANDING_KEY, JSON.stringify(branding));
    return branding;
  };
  const put = async (branding: Branding): Promise<BrandingSaved> => {
    const saved = await api.put<BrandingSaved>('/organization/branding', branding);
    return { branding: remember(saved.branding), adjustments: saved.adjustments };
  };
  return {
    cached: () => readCache(storage),
    load: async () => {
      try {
        return remember((await api.get<BrandingView>('/organization/branding')).branding);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return remember(DEFAULT_BRANDING);
        throw error;
      }
    },
    save: put,
    reset: () => put(DEFAULT_BRANDING),
  };
}
