import { Card, EmptyState, Icon, PageHeader } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { openGrants } from '../support-access/grants.js';
import { usePlatformApi } from './session.js';
import { GrantTable, grantsKey } from './support-ui.js';

/**
 * /platform/support — support access that still needs someone: waiting for the
 * business, or running (open the read-only view, or end it). New requests start
 * on a business's page.
 */
export function SupportPage() {
  const { t } = useI18n();
  const api = usePlatformApi();
  const grants = useQuery({
    queryKey: grantsKey(),
    queryFn: ({ signal }) => api.grants(undefined, signal),
    // The business may approve at any moment.
    refetchInterval: 15_000,
  });
  return (
    <>
      <PageHeader
        title={t('platform.support.title')}
        description={t('platform.support.description')}
      />
      <Card>
        <QueryState query={grants} error="platform.support.error">
          {(all) => {
            const { pending, active } = openGrants(all);
            const open = [...active, ...pending];
            return open.length === 0 ? (
              <EmptyState
                icon={<Icon name="lock" size={32} />}
                title={t('platform.support.empty')}
              />
            ) : (
              <GrantTable grants={open} showBusiness />
            );
          }}
        </QueryState>
      </Card>
    </>
  );
}
