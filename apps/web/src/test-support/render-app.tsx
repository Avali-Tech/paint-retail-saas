import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import type { SessionGrant } from '../api/types.js';
import { AppProviders } from '../app/App.js';
import { AppRoutes } from '../app/routes.js';
import { createServices } from '../app/services.js';
import { SESSION_KEY } from '../auth/session-store.js';
import { FINE_SUBSCRIPTION } from './billing-fixtures.js';
import { GRANT, fakeFetch, json, type FakeHandler } from './fake-api.js';

export interface RenderOptions {
  /** Where the app starts. */
  readonly path?: string;
  readonly routes?: Record<string, FakeHandler>;
  /** Signed in with this session (the default); null = signed out. */
  readonly session?: SessionGrant | null;
  /** What to render instead of the app's routes. */
  readonly element?: ReactNode;
}

/** Shows the current address so tests can check navigation. */
export function LocationDisplay() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

/** The real app (providers, routes, API client) over a fake API. */
export function renderApp({
  path = '/',
  routes = {},
  session = GRANT,
  element,
}: RenderOptions = {}) {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  const api = fakeFetch({
    'GET /search/actions': () => json([]),
    'GET /notifications': () => json({ items: [], total: 0, unread: 0 }),
    // Nothing waiting: no badge on Home, unless a test says otherwise.
    'GET /inbox/count': () => json({ total: 0 }),
    // A paid subscription in good standing: no banner, unless a test says otherwise.
    'GET /subscription/status': () => json(FINE_SUBSCRIPTION),
    ...routes,
  });
  const services = createServices({ fetch: api.fetch, storage: localStorage, apiBaseUrl: '/api' });
  // Tests should fail fast instead of retrying.
  services.queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  const user = userEvent.setup();
  const view = render(
    <AppProviders services={services}>
      <MemoryRouter initialEntries={[path]}>
        {element ?? <AppRoutes />}
        <Routes>
          <Route path="*" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
  return { ...view, services, requests: api.requests, user };
}
