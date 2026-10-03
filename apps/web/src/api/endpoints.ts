import type { QuickAction } from '@paint/shared';
import { catalogEndpoints } from './catalog.js';
import type { ApiClient } from './client.js';
import { creditEndpoints } from './credit.js';
import { importEndpoints } from './imports.js';
import { loyaltyEndpoints } from './loyalty.js';
import { partyEndpoints } from './parties.js';
import { purchasingEndpoints } from './purchasing.js';
import { stockCountEndpoints } from './stock-counts.js';
import { stockEndpoints } from './stock.js';
import { transferEndpoints } from './transfers.js';
import type { Dashboard, NotificationPage, Profile, SearchResults, SessionGrant } from './types.js';

export interface PasswordSignIn {
  readonly identifier: string;
  readonly password: string;
  readonly organizationId?: string;
}

export interface OtpSignIn {
  readonly phone: string;
  readonly code: string;
  readonly organizationId?: string;
}

/** Typed calls for the API routes the web app uses. */
export function endpoints(api: ApiClient) {
  return {
    auth: {
      login: (input: PasswordSignIn) => api.post<SessionGrant>('/auth/login', input),
      requestOtp: (phone: string) => api.post<{ message: string }>('/auth/otp/request', { phone }),
      verifyOtp: (input: OtpSignIn) => api.post<SessionGrant>('/auth/otp/verify', input),
      me: (signal?: AbortSignal) => api.get<Profile>('/auth/me', { signal }),
      logout: () => api.post<undefined>('/auth/logout'),
    },
    dashboard: (storeId?: string, signal?: AbortSignal) =>
      api.get<Dashboard>('/dashboard', { query: { storeId }, signal }),
    search: (q: string, signal?: AbortSignal) =>
      api.get<SearchResults>('/search', { query: { q }, signal }),
    quickActions: (q = '') => api.get<QuickAction[]>('/search/actions', { query: { q } }),
    notifications: {
      list: (limit = 10) => api.get<NotificationPage>('/notifications', { query: { limit } }),
      markRead: (id: string) => api.post<undefined>(`/notifications/${id}/read`),
      markAllRead: () => api.post<{ marked: number }>('/notifications/read-all'),
    },
    parties: partyEndpoints(api),
    credit: creditEndpoints(api),
    loyalty: loyaltyEndpoints(api),
    catalog: catalogEndpoints(api),
    stock: stockEndpoints(api),
    transfers: transferEndpoints(api),
    stockCounts: stockCountEndpoints(api),
    purchasing: purchasingEndpoints(api),
    imports: importEndpoints(api),
  };
}

export type Endpoints = ReturnType<typeof endpoints>;
