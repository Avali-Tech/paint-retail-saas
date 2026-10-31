import type { Permission } from '@paint/shared';
import { Alert, Button, EmptyState, Icon, Spinner } from '@paint/ui';
import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useServices } from '../app/services.js';
import { usePermissions, useProfile, useSession } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { SUPPORT_ROLE_KEY, isSupportTab, leaveSupportTab } from '../support-access/support-tab.js';
import { visibleNav } from './sections.js';

/** Signed-in pages: sends visitors to sign in, waits for the profile, then shows the page. */
export function RequireAuth({ children }: { readonly children: ReactNode }) {
  const { t } = useI18n();
  const { session, ended } = useSession();
  const location = useLocation();
  const profile = useProfile();

  if (session === null) {
    // Come back here after signing in, but not after signing out (the next person on a shared
    // counter device should start at the dashboard) or after a rejected support link.
    const state =
      ended === 'signed-out' || ended === 'support-rejected'
        ? null
        : { from: location.pathname + location.search };
    return <Navigate to="/sign-in" replace state={state} />;
  }
  if (profile.isPending) {
    return (
      <div className="full-page">
        <Spinner size="lg" label={t('common.loading')} />
      </div>
    );
  }
  if (profile.isError) {
    return (
      <div className="full-page">
        <Alert
          tone="danger"
          action={
            <Button
              variant="secondary"
              onClick={() => {
                void profile.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          }
        >
          {errorMessage(profile.error)}
        </Alert>
      </div>
    );
  }
  // A support view must carry a support session: anything else handed over in a link is
  // someone's own account (session fixation), so it is ended before any of it shows.
  if (isSupportTab() && profile.data.role.key !== SUPPORT_ROLE_KEY) return <RejectHandedSession />;
  return children;
}

/** Ends a session that a support view link handed over but is not platform support's. */
function RejectHandedSession() {
  const { t } = useI18n();
  const { sessions } = useServices();
  useEffect(() => {
    // Signing in again clears whatever was cached for that session (useStartSession).
    leaveSupportTab();
    sessions.end('support-rejected');
  }, [sessions]);
  return (
    <div className="full-page">
      <Spinner size="lg" label={t('common.loading')} />
    </div>
  );
}

/** A page for members holding `permission`; others are told why they cannot see it. */
export function RequirePermission({
  permission,
  children,
}: {
  readonly permission: Permission;
  readonly children: ReactNode;
}) {
  const { t } = useI18n();
  const can = usePermissions();
  if (can(permission)) return children;
  return (
    <EmptyState
      icon={<Icon name="alert" size={32} />}
      title={t('pages.noAccessTitle')}
      description={t('pages.noAccess')}
    />
  );
}

/** "/" opens the first page the member's role gives them (the dashboard for most). */
export function HomeRedirect() {
  const can = usePermissions();
  // Not a page everyone has, such as account security.
  const first = visibleNav(can).find((item) => item.permission !== undefined);
  return <Navigate to={first ? first.path : '/follow-ups'} replace />;
}
