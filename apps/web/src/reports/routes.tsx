import { lazy, type ReactNode } from 'react';
import { Route } from 'react-router';
import { RequireAnyPermission } from '../lib/guard.js';
import { REPORT_PERMISSIONS } from './nav.js';

// Reports. Each screen is its own chunk, loaded when first opened.
const ReportsPage = lazy(() =>
  import('./ReportsPage.js').then((module) => ({ default: module.ReportsPage })),
);
const ReportPage = lazy(() =>
  import('./ReportPage.js').then((module) => ({ default: module.ReportPage })),
);

/** Reports, for members who may run at least one. */
export function reportRoutes() {
  const guard = (page: ReactNode) => (
    <RequireAnyPermission permissions={REPORT_PERMISSIONS}>{page}</RequireAnyPermission>
  );
  return (
    <>
      <Route path="reports" element={guard(<ReportsPage />)} />
      <Route path="reports/:kind" element={guard(<ReportPage />)} />
    </>
  );
}
