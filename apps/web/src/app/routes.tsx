import { EmptyState, Icon, buttonStyle } from '@paint/ui';
import { Link, Route, Routes } from 'react-router';
import { SignInPage } from '../auth/SignInPage.js';
import { DashboardPage } from '../dashboard/DashboardPage.js';
import { useI18n } from '../i18n/i18n.js';
import { AppearancePage } from '../settings/AppearancePage.js';
import { SecurityPage } from '../settings/SecurityPage.js';
import { AppShell } from '../shell/AppShell.js';
import { HomeRedirect, RequireAuth, RequirePermission } from '../shell/guards.js';

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
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<HomeRedirect />} />
        <Route
          path="dashboard"
          element={
            <RequirePermission permission="stores:read">
              <DashboardPage />
            </RequirePermission>
          }
        />
        <Route
          path="settings/appearance"
          element={
            <RequirePermission permission="organization:manage">
              <AppearancePage />
            </RequirePermission>
          }
        />
        <Route path="settings/security" element={<SecurityPage />} />
        {/* Quick actions whose screens come with their modules. */}
        <Route
          path="credit-requests/new"
          element={
            <RequirePermission permission="credit:manage">
              <ComingSoonPage />
            </RequirePermission>
          }
        />
        <Route
          path="loyalty/new"
          element={
            <RequirePermission permission="loyalty:manage">
              <ComingSoonPage />
            </RequirePermission>
          }
        />
        {/* Customers, products, stock, other quick actions and search results land here for now. */}
        <Route path="*" element={<ComingSoonPage />} />
      </Route>
    </Routes>
  );
}
