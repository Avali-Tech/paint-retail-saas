import './support-access.css';
import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// The business's side of platform support access. Each screen is its own chunk.
const SupportAccessPage = lazy(() =>
  import('./SupportAccessPage.js').then((module) => ({ default: module.SupportAccessPage })),
);
const SupportRequestPage = lazy(() =>
  import('./SupportRequestPage.js').then((module) => ({ default: module.SupportRequestPage })),
);

/** Settings → Support access; every support-requests route needs organization:manage. */
export function supportAccessRoutes() {
  return (
    <>
      <Route path="settings/support" element={guarded('organization:manage', SupportAccessPage)} />
      <Route
        path="settings/support/:id"
        element={guarded('organization:manage', SupportRequestPage)}
      />
    </>
  );
}
