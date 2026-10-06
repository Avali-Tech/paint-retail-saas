import type { Tone } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../api/client.js';
import { useApi } from '../app/services.js';
import type { I18n } from '../i18n/i18n.js';
import type { GrantStatus, GrantView } from '../platform/platform-api.js';

/** One request platform support made with its access (GET /support-requests/:id/activity). */
export interface AccessLogEntry {
  readonly at: string;
  readonly method: string;
  readonly path: string;
}

/** The business's side of support access; every route needs organization:manage. */
export function supportRequestEndpoints(api: ApiClient) {
  return {
    list: (signal?: AbortSignal) => api.get<GrantView[]>('/support-requests', { signal }),
    approve: (id: string) => api.post<GrantView>(`/support-requests/${id}/approve`),
    decline: (id: string) => api.post<GrantView>(`/support-requests/${id}/decline`),
    end: (id: string) => api.post<GrantView>(`/support-requests/${id}/end`),
    activity: (id: string, signal?: AbortSignal) =>
      api.get<AccessLogEntry[]>(`/support-requests/${id}/activity`, { signal }),
  };
}

export const supportRequestsKey = ['support-requests'] as const;

/**
 * The business's support access requests, shared by the banner and the
 * screens. `select` picks what a screen needs; `refetchInterval` keeps it fresh.
 */
export function useSupportRequests<T = GrantView[]>(
  options: { select?: (grants: GrantView[]) => T; refetchInterval?: number } = {},
) {
  const api = useApi();
  return useQuery({
    queryKey: supportRequestsKey,
    queryFn: ({ signal }) => api.supportRequests.list(signal),
    ...options,
  });
}

/** "1 hour" or "2 hours" for whole hours, else "45 minutes". */
export function grantLength(plural: I18n['plural'], minutes: number): string {
  return minutes % 60 === 0
    ? plural('supportAccess.hours', minutes / 60)
    : plural('supportAccess.minutes', minutes);
}

/** How each status stands out: waiting and running access draw the eye. */
export const GRANT_TONES: Readonly<Record<GrantStatus, Tone>> = {
  pending: 'warning',
  active: 'success',
  declined: 'neutral',
  expired: 'neutral',
  ended: 'neutral',
};

/** The grants that still need someone: waiting for a decision, or running. */
export function openGrants(grants: readonly GrantView[]): {
  readonly pending: GrantView[];
  readonly active: GrantView[];
  readonly closed: GrantView[];
} {
  return {
    pending: grants.filter((grant) => grant.status === 'pending'),
    active: grants.filter((grant) => grant.status === 'active'),
    closed: grants.filter((grant) => grant.status !== 'pending' && grant.status !== 'active'),
  };
}
