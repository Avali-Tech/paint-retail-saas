import { BRAND_PROFITABILITY_PERMISSION } from '@paint/shared';
import { lazy, type ReactNode } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';
import { RequireAnyPermission } from '../lib/guard.js';
import { REPORT_PERMISSIONS } from './nav.js';

// Reports. Each screen is its own chunk, loaded when first opened.
const ReportsPage = lazy(() =>
  import('./ReportsPage.js').then((module) => ({ default: module.ReportsPage })),
);
const BrandProfitabilityPage = lazy(() =>
  import('../brand-profitability/BrandProfitabilityPage.js').then((module) => ({
    default: module.BrandProfitabilityPage,
  })),
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
      <Route
        path="reports/brand-profitability"
        element={guarded(BRAND_PROFITABILITY_PERMISSION, BrandProfitabilityPage)}
      />
      <Route path="reports/:kind" element={guard(<ReportPage />)} />
    </>
  );
}
