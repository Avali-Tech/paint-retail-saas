import type { TintRecordPage, TintRecordQuery } from '@paint/shared';
import type { ApiClient } from '../api/client.js';

// The shade-history search (round 5a's GET /tint-records); a line's own tint travels
// inline with the draft's lines.

export function tintEndpoints(api: ApiClient) {
  return {
    /** The business's shade history, every store, newest first. */
    history: (query: TintRecordQuery, signal?: AbortSignal) =>
      api.get<TintRecordPage>('/tint-records', { query: { ...query }, signal }),
  };
}

export type TintEndpoints = ReturnType<typeof tintEndpoints>;
