import { QueryClient } from '@tanstack/react-query';
import { createContext, use, type ReactNode } from 'react';
import { createApiClient } from '../api/client.js';
import { endpoints, type Endpoints } from '../api/endpoints.js';
import { ApiError } from '../api/errors.js';
import { createSessionStore, type SessionStore } from '../auth/session-store.js';
import { platformEndpoints, type PlatformEndpoints } from '../platform/platform-api.js';
import {
  createPlatformSessionStore,
  type PlatformSessionStore,
} from '../platform/platform-session-store.js';
import { apiBrandingSource, type BrandingSource } from '../theme/branding-source.js';
import { apiIdentitySource, type IdentitySource } from '../theme/identity-source.js';
import { apiSignInBusinessSource, type SignInBusinessSource } from '../theme/sign-in-business.js';

/** Everything the app talks to, created once at start-up (tests pass fakes). */
export interface Services {
  readonly sessions: SessionStore;
  readonly api: Endpoints;
  readonly branding: BrandingSource;
  /** The business's sign-in link name and logo. */
  readonly identity: IdentitySource;
  /** Which business's look the sign-in page wears before anyone signs in. */
  readonly signInBusiness: SignInBusinessSource;
  readonly queryClient: QueryClient;
  /** The platform console's own session and API client, apart from the business's. */
  readonly platform: { readonly sessions: PlatformSessionStore; readonly api: PlatformEndpoints };
}

export interface ServiceOptions {
  readonly fetch: typeof fetch;
  readonly storage: Storage;
  /** Where the API is reached from the browser; "/api" is proxied to it (see vite.config.ts). */
  readonly apiBaseUrl: string;
}

/** Retry only problems that may go away: the network or a server error, at most twice. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  const transient = !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
  return transient && failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 30_000 },
      mutations: { retry: false },
    },
  });
}

export function createServices(options: ServiceOptions): Services {
  const sessions = createSessionStore(options.storage);
  const client = createApiClient({
    baseUrl: options.apiBaseUrl,
    fetch: options.fetch,
    getToken: () => sessions.getToken(),
    onUnauthorized: () => {
      sessions.end('expired');
    },
  });
  const platformSessions = createPlatformSessionStore(options.storage);
  const platformClient = createApiClient({
    baseUrl: options.apiBaseUrl,
    fetch: options.fetch,
    getToken: () => platformSessions.getToken(),
    onUnauthorized: () => {
      platformSessions.end('expired');
    },
  });
  const signInBusiness = apiSignInBusinessSource(client, options.storage);
  return {
    sessions,
    api: endpoints(client),
    platform: { sessions: platformSessions, api: platformEndpoints(platformClient) },
    branding: apiBrandingSource(client, options.storage),
    identity: apiIdentitySource(client, options.storage, options.apiBaseUrl, signInBusiness),
    signInBusiness,
    queryClient: createQueryClient(),
  };
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({
  services,
  children,
}: {
  readonly services: Services;
  readonly children: ReactNode;
}) {
  return <ServicesContext value={services}>{children}</ServicesContext>;
}

export function useServices(): Services {
  const services = use(ServicesContext);
  if (!services) throw new Error('useServices must be used inside <ServicesProvider>');
  return services;
}

export function useApi(): Endpoints {
  return useServices().api;
}
