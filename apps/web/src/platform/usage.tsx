import type { TenantSubscriptionView } from '@paint/shared';
import { Badge } from '@paint/ui';
import { STATUS_TONES } from '../billing/billing-api.js';
import { useI18n } from '../i18n/i18n.js';

/** "3 of 5" against the plan's limit, flagged once the limit is reached; "12 (no limit)" otherwise. */
export function Usage({ used, limit }: { readonly used: number; readonly limit: number | null }) {
  const { t, number } = useI18n();
  if (limit === null) return <>{t('platform.tenants.unlimited', { used: number(used) })}</>;
  return (
    <span className="badges">
      {t('platform.tenants.usage', { used: number(used), limit: number(limit) })}
      {used >= limit && <Badge tone="danger">{t('platform.tenants.atLimit')}</Badge>}
    </span>
  );
}

/** The subscription's status, and "Read-only" once the business can no longer save. */
export function SubscriptionBadges({
  subscription,
}: {
  readonly subscription: TenantSubscriptionView;
}) {
  const { t } = useI18n();
  return (
    <span className="badges">
      <Badge tone={STATUS_TONES[subscription.status]}>
        {t(`subscription.statuses.${subscription.status}`)}
      </Badge>
      {subscription.readOnly && <Badge tone="danger">{t('platform.tenant.readOnly')}</Badge>}
    </span>
  );
}
