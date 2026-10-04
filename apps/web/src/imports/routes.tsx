import '../styles/inventory.css';
import './imports.css';
import { lazy } from 'react';
import { Route } from 'react-router';
import { RequireAnyPermission } from '../lib/guard.js';
import { IMPORT_PERMISSIONS } from './nav.js';

// The import screen, its own chunk loaded when first opened.
const ImportsPage = lazy(() =>
  import('./ImportsPage.js').then((module) => ({ default: module.ImportsPage })),
);

/** Imports, for members who may import at least one kind of data. */
export function importRoutes() {
  return (
    <Route
      path="imports"
      element={
        <RequireAnyPermission permissions={IMPORT_PERMISSIONS}>
          <ImportsPage />
        </RequireAnyPermission>
      }
    />
  );
}
