import type { SubscriptionStatusView } from '@paint/shared';
import { Alert, buttonStyle } from '@paint/ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useCurrentProfile } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { SUPPORT_ROLE_KEY } from '../support-access/support-tab.js';
import { useSubscriptionStatus } from './billing-api.js';

/** Warn about a trial ending within this many days. */
export const TRIAL_WARNING_DAYS = 7;

function Banner({
  tone,
  title,
  children,
  action,
}: {
  readonly tone: 'info' | 'warning' | 'danger';
  readonly title: string;
  readonly children: ReactNode;
  readonly action: ReactNode;
}) {
  return (
    <div className="support-banner">
      <Alert tone={tone} title={title} action={action}>
        {children}
      </Alert>
    </div>
  );
}

function OwnerBanner({ status }: { readonly status: SubscriptionStatusView }) {
  const { t, plural, date } = useI18n();
  const open = (
    <Link to="/settings/billing" {...buttonStyle('secondary', 'sm')}>
      {t('subscription.banner.open')}
    </Link>
  );
  if (status.status === 'expired') {
    return (
      <Banner tone="danger" title={t('subscription.banner.expired')} action={open}>
        {t('subscription.banner.expiredText')}
      </Banner>
    );
  }
  if (status.readOnly) {
    return (
      <Banner tone="danger" title={t('subscription.banner.readOnly')} action={open}>
        {t('subscription.banner.readOnlyOwnerText')}
      </Banner>
    );
  }
  if (status.status === 'past_due') {
    return (
      <Banner tone="warning" title={t('subscription.banner.pastDue')} action={open}>
        {t('subscription.banner.pastDueText', { date: date(String(status.graceEndsAt)) })}
      </Banner>
    );
  }
  if (status.status === 'trialing' && Number(status.trialDaysLeft) <= TRIAL_WARNING_DAYS) {
    return (
      <Banner
        tone="info"
        title={plural('subscription.banner.trialEnding', Number(status.trialDaysLeft))}
        action={open}
      >
        {t('subscription.banner.trialEndingText')}
      </Banner>
    );
  }
  if (status.cancelAtPeriodEnd) {
    return (
      <Banner
        tone="info"
        title={t('subscription.banner.cancelling', {
          date: date(String(status.currentPeriodEnd)),
        })}
        action={open}
      >
        {t('subscription.banner.cancellingText')}
      </Banner>
    );
  }
  return null;
}

function Shown() {
  const { t } = useI18n();
  const profile = useCurrentProfile();
  const status = useSubscriptionStatus(5 * 60_000);
  if (status.data === undefined) return null;
  if (profile.role.key === 'owner') return <OwnerBanner status={status.data} />;
  if (!status.data.readOnly) return null;
  return (
    <Banner tone="danger" title={t('subscription.banner.readOnly')} action={null}>
      {t('subscription.banner.readOnlyText')}
    </Banner>
  );
}

/**
 * Above every page: the owner is warned while the trial runs out, a payment is
 * overdue, the business is read-only or the subscription is ending; everyone else
 * only when the business is read-only. Nothing in platform support's view.
 */
export function SubscriptionBanner() {
  const profile = useCurrentProfile();
  return profile.role.key === SUPPORT_ROLE_KEY ? null : <Shown />;
}
