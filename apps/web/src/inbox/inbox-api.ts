import type { InboxCount, InboxQuery, InboxView } from '@paint/shared';
import type { ApiClient } from '../api/client.js';

// The "Needs action" inbox (apps/api/src/inbox). Shapes come from @paint/shared.

export function inboxEndpoints(api: ApiClient) {
  return {
    list: (query: InboxQuery, signal?: AbortSignal) =>
      api.get<InboxView>('/inbox', { query: { ...query }, signal }),
    count: (signal?: AbortSignal) => api.get<InboxCount>('/inbox/count', { signal }),
  };
}
