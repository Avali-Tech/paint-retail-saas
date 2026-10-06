import { EmptyState, Icon, buttonStyle } from '@paint/ui';
import { lazy } from 'react';
import { Link, Route, Routes } from 'react-router';
import { SignInPage } from '../auth/SignInPage.js';
import { catalogRoutes } from '../catalog/routes.js';
import { contractRoutes } from '../contracts/routes.js';
import { followUpRoutes } from '../followups/routes.js';
import { useI18n } from '../i18n/i18n.js';
import { importRoutes } from '../imports/routes.js';
import { leadRoutes } from '../leads/routes.js';
import { opportunityRoutes } from '../opportunities/routes.js';
import { partyRoutes } from '../parties/routes.js';
import { platformRoutes } from '../platform/routes.js';
import { projectRoutes } from '../projects/routes.js';
import { purchasingRoutes } from '../purchasing/routes.js';
import { reportRoutes } from '../reports/routes.js';
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
const SecurityPage = lazy(() =>
  import('../settings/SecurityPage.js').then((module) => ({ default: module.SecurityPage })),
);

/** Sections that have a place in the navigation but no screen yet. */
export function ComingSoonPage() {
  const { t } = useI18n();
  return (
    <EmptyState
      icon={<Icon name="calendar" size={32} />}
      title={t('pages.comingSoonTitle')}
      description={t('pages.comingSoon')}
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
        {reportRoutes()}
        {teamRoutes()}
        {supportAccessRoutes()}
        <Route
          path="settings/appearance"
          element={guarded('organization:manage', AppearancePage)}
        />
        {/* Every signed-in member manages their own two-factor sign-in. */}
        <Route path="settings/security" element={<SecurityPage />} />
        {/* Leads, projects and the rest land here for now. */}
        <Route path="*" element={<ComingSoonPage />} />
      </Route>
    </Routes>
  );
}
