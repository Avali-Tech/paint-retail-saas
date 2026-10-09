import type { QuickAction } from '@paint/shared';
import { booksEndpoints } from '../books/books-api.js';
import { catalogEndpoints } from './catalog.js';
import type { ApiClient } from './client.js';
import { contractEndpoints } from './contracts.js';
import { creditEndpoints } from './credit.js';
import { documentEndpoints } from './documents.js';
import { followUpEndpoints } from './follow-ups.js';
import { importEndpoints } from './imports.js';
import { leadEndpoints, opportunityEndpoints } from './leads.js';
import { loyaltyEndpoints } from './loyalty.js';
import { partyEndpoints } from './parties.js';
import { ordersEndpoints } from '../orders/orders-api.js';
import { posEndpoints } from '../pos/pos-api.js';
import { projectEndpoints } from './projects.js';
import { purchasingEndpoints } from './purchasing.js';
import { recordActivityEndpoints } from './record-activities.js';
import { reportEndpoints } from './reports.js';
import { salesEndpoints } from './sales.js';
import { stockCountEndpoints } from './stock-counts.js';
import { stockEndpoints } from './stock.js';
import { supportRequestEndpoints } from '../support-access/grants.js';
import { taxEndpoints } from './tax.js';
import { teamEndpoints } from './team.js';
import { transferEndpoints } from './transfers.js';
import type {
  Dashboard,
  NotificationPage,
  OrganizationSecurity,
  Profile,
  SearchResults,
  SignInResult,
  TwoFactorEnrolment,
  TwoFactorSignIn,
  TwoFactorStatus,
} from './types.js';

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
      login: (input: PasswordSignIn) => api.post<SignInResult>('/auth/login', input),
      requestOtp: (phone: string) => api.post<{ message: string }>('/auth/otp/request', { phone }),
      verifyOtp: (input: OtpSignIn) => api.post<SignInResult>('/auth/otp/verify', input),
      me: (signal?: AbortSignal) => api.get<Profile>('/auth/me', { signal }),
      logout: () => api.post<undefined>('/auth/logout'),
    },
    twoFactor: {
      /** During sign-in, with the pending token: adds an authenticator app. */
      setUp: (pendingToken: string) =>
        api.post<TwoFactorEnrolment>('/auth/2fa/setup', { pendingToken }),
      /** During sign-in: a code from the app, or a recovery code, turns the pending token into a session. */
      verify: (pendingToken: string, code: string) =>
        api.post<TwoFactorSignIn>('/auth/2fa/verify', { pendingToken, code }),
      status: () => api.get<TwoFactorStatus>('/auth/2fa'),
      enrol: () => api.post<TwoFactorEnrolment>('/auth/2fa/enrol'),
      confirm: (code: string) =>
        api.post<{ recoveryCodes: string[] }>('/auth/2fa/confirm', { code }),
      renewRecoveryCodes: (code: string) =>
        api.post<{ recoveryCodes: string[] }>('/auth/2fa/recovery-codes', { code }),
      disable: (code: string) => api.post<undefined>('/auth/2fa/disable', { code }),
    },
    organization: {
      security: () => api.get<OrganizationSecurity>('/organization/security'),
      setSecurity: (input: OrganizationSecurity) =>
        api.put<OrganizationSecurity>('/organization/security', input),
    },
    team: teamEndpoints(api),
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
    tax: taxEndpoints(api),
    sales: salesEndpoints(api),
    catalog: catalogEndpoints(api),
    stock: stockEndpoints(api),
    transfers: transferEndpoints(api),
    stockCounts: stockCountEndpoints(api),
    purchasing: purchasingEndpoints(api),
    imports: importEndpoints(api),
    leads: leadEndpoints(api),
    opportunities: opportunityEndpoints(api),
    projects: projectEndpoints(api),
    recordActivities: recordActivityEndpoints(api),
    followUps: followUpEndpoints(api),
    contracts: contractEndpoints(api),
    documents: documentEndpoints(api),
    reports: reportEndpoints(api),
    supportRequests: supportRequestEndpoints(api),
    pos: posEndpoints(api),
    orders: ordersEndpoints(api),
    books: booksEndpoints(api),
  };
}

export type Endpoints = ReturnType<typeof endpoints>;
