import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// Setting the business up: each screen is its own chunk.
const StoresPage = lazy(() =>
  import('./StoresPage.js').then((module) => ({ default: module.StoresPage })),
);
const GettingStartedPage = lazy(() =>
  import('./GettingStartedPage.js').then((module) => ({ default: module.GettingStartedPage })),
);
const GoLivePage = lazy(() =>
  import('./GoLivePage.js').then((module) => ({ default: module.GoLivePage })),
);

/** Stores (stores:manage), the billing go-live and Getting started (organization:manage). */
export function setupRoutes() {
  return (
    <>
      <Route path="settings/stores" element={guarded('stores:manage', StoresPage)} />
      <Route path="settings/go-live" element={guarded('organization:manage', GoLivePage)} />
      <Route
        path="settings/getting-started"
        element={guarded('organization:manage', GettingStartedPage)}
      />
    </>
  );
}
