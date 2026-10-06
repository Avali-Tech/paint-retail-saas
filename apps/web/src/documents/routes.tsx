import '../styles/customers.css';
import { lazy } from 'react';
import { Route } from 'react-router';
import { RequireAnyPermission } from '../lib/guard.js';
import { DOCUMENT_READ_PERMISSIONS } from './nav.js';

// Documents across records. Each screen is its own chunk, loaded when first opened.
const DocumentsPage = lazy(() =>
  import('./DocumentsPage.js').then((module) => ({ default: module.DocumentsPage })),
);

/** Every document on the records the member can see. */
export function documentRoutes() {
  return (
    <Route
      path="documents"
      element={
        <RequireAnyPermission permissions={DOCUMENT_READ_PERMISSIONS}>
          <DocumentsPage />
        </RequireAnyPermission>
      }
    />
  );
}
