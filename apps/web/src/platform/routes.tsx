import '../styles/inventory.css';
import './platform.css';
import { lazy } from 'react';
import { Navigate, Route } from 'react-router';
import { PlatformLayout, RequirePlatformAuth } from './PlatformLayout.js';
import { PlatformSignInPage } from './PlatformSignInPage.js';

// The platform console, outside the business's shell and session. Like the business's
// sign-in, the console's sign-in loads at once; every other screen is its own chunk.
const TenantsPage = lazy(() =>
  import('./TenantsPage.js').then((module) => ({ default: module.TenantsPage })),
);
const TenantDetailPage = lazy(() =>
  import('./TenantDetailPage.js').then((module) => ({ default: module.TenantDetailPage })),
);
const SupportPage = lazy(() =>
  import('./SupportPage.js').then((module) => ({ default: module.SupportPage })),
);
const AccessLogPage = lazy(() =>
  import('./AccessLogPage.js').then((module) => ({ default: module.AccessLogPage })),
);

/** /platform/…: the operators' console, with its own sign-in. */
export function platformRoutes() {
  return (
    <>
      <Route path="platform/sign-in" element={<PlatformSignInPage />} />
      <Route
        path="platform"
        element={
          <RequirePlatformAuth>
            <PlatformLayout />
          </RequirePlatformAuth>
        }
      >
        <Route index element={<Navigate to="/platform/tenants" replace />} />
        <Route path="tenants" element={<TenantsPage />} />
        <Route path="tenants/:id" element={<TenantDetailPage />} />
        <Route path="support" element={<SupportPage />} />
        <Route path="access-log" element={<AccessLogPage />} />
        <Route path="*" element={<Navigate to="/platform/tenants" replace />} />
      </Route>
    </>
  );
}
