import { Alert, buttonStyle } from '@paint/ui';
import { Link } from 'react-router';
import { useCurrentProfile, usePermissions, useSession } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { openGrants, useSupportRequests } from './grants.js';
import { SUPPORT_ROLE_KEY } from './support-tab.js';

/** In a support view: says plainly that this is platform support, read-only, and until when. */
function SupportViewBanner() {
  const { t, dateTime } = useI18n();
  const profile = useCurrentProfile();
  const { session } = useSession();
  return (
    <div className="support-banner">
      <Alert tone="warning" title={t('supportAccess.banner.supportView')}>
        {t('supportAccess.banner.supportViewText', {
          business: profile.organization.name,
          // Signed in, so there is a session.
          time: dateTime(String(session?.expiresAt)),
        })}
      </Alert>
    </div>
  );
}

/** For owners and admins: platform support can see the business now, or is asking to. */
function DecidersBanner() {
  const { t, dateTime } = useI18n();
  const grants = useSupportRequests({ refetchInterval: 60_000 });
  const { pending, active } = openGrants(grants.data ?? []);
  const [running] = active;
  const [asking] = pending;
  const review = (
    <Link to="/settings/support" {...buttonStyle('secondary', 'sm')}>
      {t('supportAccess.banner.review')}
    </Link>
  );
  if (running !== undefined) {
    return (
      <div className="support-banner">
        <Alert tone="warning" title={t('supportAccess.banner.active')} action={review}>
          {t('supportAccess.banner.activeText', {
            name: running.requestedBy,
            time: dateTime(String(running.expiresAt)),
          })}
        </Alert>
      </div>
    );
  }
  if (asking !== undefined) {
    return (
      <div className="support-banner">
        <Alert tone="info" title={t('supportAccess.banner.pending')} action={review}>
          {t('supportAccess.banner.pendingText', {
            name: asking.requestedBy,
            reason: asking.reason,
          })}
        </Alert>
      </div>
    );
  }
  return null;
}

/**
 * Shown above every page of the business's app while platform support is
 * involved: in support's own read-only view, and to the owners and admins who
 * decide while access runs or a request waits.
 */
export function SupportBanner() {
  const profile = useCurrentProfile();
  const can = usePermissions();
  if (profile.role.key === SUPPORT_ROLE_KEY) return <SupportViewBanner />;
  return can('organization:manage') ? <DecidersBanner /> : null;
}
