import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// Setting the business up: each screen is its own chunk.
const StoresPage = lazy(() =>
  import('./StoresPage.js').then((module) => ({ default: module.StoresPage })),
);
const GoLivePage = lazy(() =>
  import('./GoLivePage.js').then((module) => ({ default: module.GoLivePage })),
);

/** Stores (stores:manage) and the billing go-live (organization:manage). */
export function setupRoutes() {
  return (
    <>
      <Route path="settings/stores" element={guarded('stores:manage', StoresPage)} />
      <Route path="settings/go-live" element={guarded('organization:manage', GoLivePage)} />
    </>
  );
}
