import type { MistintPage, MistintStatus, MistintView, RecordMistintInput } from '@paint/shared';
import type { ApiClient } from './client.js';

// Mistinted cans (apps/api/src/mistints): recorded, listed for every branch, written off.

export interface MistintQuery {
  readonly status?: MistintStatus;
  readonly storeId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export function mistintEndpoints(api: ApiClient) {
  return {
    list: (query: MistintQuery, signal?: AbortSignal) =>
      api.get<MistintPage>('/mistinted-cans', { query: { ...query }, signal }),
    get: (id: string, signal?: AbortSignal) =>
      api.get<MistintView>(`/mistinted-cans/${id}`, { signal }),
    record: (input: RecordMistintInput) => api.post<MistintView>('/mistinted-cans', input),
    writeOff: (id: string, note: string) =>
      api.post<MistintView>(`/mistinted-cans/${id}/write-off`, { note }),
  };
}
