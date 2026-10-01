import type { Permission } from '@paint/shared';
import { Alert, Button, EmptyState, Icon, Spinner } from '@paint/ui';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { usePermissions, useProfile, useSession } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { visibleNav } from './nav.js';

/** Signed-in pages: sends visitors to sign in, waits for the profile, then shows the page. */
export function RequireAuth({ children }: { readonly children: ReactNode }) {
  const { t } = useI18n();
  const { session } = useSession();
  const location = useLocation();
  const profile = useProfile();

  if (session === null) {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname + location.search }} />;
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
  return children;
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

/** "/" opens the first section the member may use (the dashboard for most). */
export function HomeRedirect() {
  const can = usePermissions();
  const [first] = visibleNav(can);
  return <Navigate to={first ? first.path : '/follow-ups'} replace />;
}
