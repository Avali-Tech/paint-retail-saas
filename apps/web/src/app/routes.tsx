import { EmptyState, Icon, buttonStyle } from '@paint/ui';
import { lazy } from 'react';
import { Link, Route, Routes } from 'react-router';
import { SignInPage } from '../auth/SignInPage.js';
import { booksRoutes } from '../books/routes.js';
import { catalogRoutes } from '../catalog/routes.js';
import { contractRoutes } from '../contracts/routes.js';
import { documentRoutes } from '../documents/routes.js';
import { followUpRoutes } from '../followups/routes.js';
import { useI18n } from '../i18n/i18n.js';
import { importRoutes } from '../imports/routes.js';
import { leadRoutes } from '../leads/routes.js';
import { opportunityRoutes } from '../opportunities/routes.js';
import { estimatorRoutes } from '../estimator/routes.js';
import { orderRoutes } from '../orders/routes.js';
import { partyRoutes } from '../parties/routes.js';
import { platformRoutes } from '../platform/routes.js';
import { posRoutes } from '../pos/routes.js';
import { printRoutes } from '../print/routes.js';
import { projectRoutes } from '../projects/routes.js';
import { purchasingRoutes } from '../purchasing/routes.js';
import { receivablesRoutes } from '../receivables/routes.js';
import { reportRoutes } from '../reports/routes.js';
import { salesRoutes } from '../sales/routes.js';
import { AppShell } from '../shell/AppShell.js';
import { HomeRedirect, RequireAuth } from '../shell/guards.js';
import { stockCountRoutes } from '../stock-counts/routes.js';
import { stockRoutes } from '../stock/routes.js';
import { supportAccessRoutes } from '../support-access/routes.js';
import { teamRoutes } from '../team/routes.js';
import { transferRoutes } from '../transfers/routes.js';
import { guarded } from './guarded.js';

// Every screen is its own chunk, loaded when first opened, so a phone downloads
// only the shell and the screen in front of it. AppShell shows a spinner meanwhile.
const DashboardPage = lazy(() =>
  import('../dashboard/DashboardPage.js').then((module) => ({ default: module.DashboardPage })),
);
const AppearancePage = lazy(() =>
  import('../settings/AppearancePage.js').then((module) => ({ default: module.AppearancePage })),
);
const TaxSettingsPage = lazy(() =>
  import('../settings/TaxSettingsPage.js').then((module) => ({ default: module.TaxSettingsPage })),
);
const InvoicePrintSettingsPage = lazy(() =>
  import('../settings/InvoicePrintSettingsPage.js').then((module) => ({
    default: module.InvoicePrintSettingsPage,
  })),
);
const SecurityPage = lazy(() =>
  import('../settings/SecurityPage.js').then((module) => ({ default: module.SecurityPage })),
);

/** An address inside the app that leads to no screen (a mistyped or old link). */
export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <EmptyState
      icon={<Icon name="search" size={32} />}
      title={t('pages.notFoundTitle')}
      description={t('pages.notFound')}
      action={
        <Link to="/" {...buttonStyle('secondary')}>
          {t('common.backToDashboard')}
        </Link>
      }
    />
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignInPage />} />
      {platformRoutes()}
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<HomeRedirect />} />
        <Route path="dashboard" element={guarded('stores:read', DashboardPage)} />
        {posRoutes()}
        {partyRoutes()}
        {catalogRoutes()}
        {stockRoutes()}
        {transferRoutes()}
        {stockCountRoutes()}
        {purchasingRoutes()}
        {importRoutes()}
        {leadRoutes()}
        {opportunityRoutes()}
        {projectRoutes()}
        {followUpRoutes()}
        {contractRoutes()}
        {estimatorRoutes()}
        {orderRoutes()}
        {salesRoutes()}
        {booksRoutes()}
        {receivablesRoutes()}
        {documentRoutes()}
        {reportRoutes()}
        {teamRoutes()}
        {supportAccessRoutes()}
        {printRoutes()}
        <Route
          path="settings/appearance"
          element={guarded('organization:manage', AppearancePage)}
        />
        <Route path="settings/tax" element={guarded('tax:read', TaxSettingsPage)} />
        <Route
          path="settings/invoice-print"
          element={guarded('organization:manage', InvoicePrintSettingsPage)}
        />
        {/* Every signed-in member manages their own two-factor sign-in. */}
        <Route path="settings/security" element={<SecurityPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
