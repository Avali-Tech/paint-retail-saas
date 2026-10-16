import type { GoLivePreview, GoLiveRequest, GoLiveResult } from '@paint/shared';
import type { ApiClient } from '../api/client.js';
import type { Store } from '../api/stock.js';
import type { StoreGstInput } from '../api/tax.js';

// Setting a business up for its pilot (PO-100, PO-102): its stores and the billing go-live.

export const STORES_KEY = ['settings', 'stores'] as const;
export const GO_LIVE_KEY = ['settings', 'go-live'] as const;

export interface NewStore {
  readonly name: string;
  readonly code: string;
  readonly type: Store['type'];
  /** Saved with the store in one go; needs tax:manage. */
  readonly registration?: StoreGstInput;
}

export interface StoreChanges {
  readonly name?: string;
  readonly type?: Store['type'];
  readonly isActive?: boolean;
}

export function setupEndpoints(api: ApiClient) {
  return {
    stores: (signal?: AbortSignal) => api.get<Store[]>('/stores', { signal }),
    createStore: (input: NewStore) => api.post<Store>('/stores', input),
    updateStore: (id: string, changes: StoreChanges) => api.patch<Store>(`/stores/${id}`, changes),
    /** What going live on `liveOn` (default today) would post, or what it posted. */
    goLive: (liveOn: string | undefined, signal?: AbortSignal) =>
      api.get<GoLivePreview>('/sales/go-live', { query: { liveOn }, signal }),
    /** Once per business; the key makes a retried post (a lost answer) count once. */
    postGoLive: (input: GoLiveRequest, idempotencyKey: string) =>
      api.post<GoLiveResult>('/sales/go-live', input, {
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
  };
}
