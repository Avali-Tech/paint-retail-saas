import { Badge, Card, Skeleton } from '@paint/ui';
import { RECEIVABLES_PERMISSION } from '@paint/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';

/**
 * The dashboard's receivables tile (roadmap P2-M10): what customers owe, how much of
 * it is overdue and what falls due this week, at the store the dashboard shows. Only
 * for members who see credit; its own request, so the rest of the dashboard never waits.
 */
export function ReceivablesTile({ storeId }: { readonly storeId: string | null }) {
  const can = usePermissions();
  if (!can(RECEIVABLES_PERMISSION)) return null;
  return <Figures storeId={storeId} />;
}

function Figures({ storeId }: { readonly storeId: string | null }) {
  const api = useApi();
  const { t, money, compactMoney } = useI18n();
  const filters = storeId === null ? {} : { storeId };
  const summary = useQuery({
    queryKey: ['receivables', 'summary', filters],
    queryFn: ({ signal }) => api.receivables.summary(filters, signal),
  });
  const data = summary.data;
  return (
    <Card className="tile">
      <h2 className="tile__title">{t('receivables.tile.title')}</h2>
      {summary.isError ? (
        <p className="muted">{t('receivables.error')}</p>
      ) : data === undefined ? (
        <Skeleton className="tile__skeleton" />
      ) : (
        <>
          <p className="tile__value">
            <span title={money(data.totals.outstandingPaise)}>
              {compactMoney(data.totals.outstandingPaise)}
            </span>
          </p>
          <div className="tile__details">
            <span className="figure">
              <span className="muted">{t('receivables.tile.overdue')}</span>{' '}
              {data.overduePaise > 0 ? (
                <Badge tone="danger">{money(data.overduePaise)}</Badge>
              ) : (
                <strong>{money(0)}</strong>
              )}
            </span>
            <span className="figure">
              <span className="muted">{t('receivables.tile.dueThisWeek')}</span>{' '}
              <strong>{money(data.dueThisWeekPaise)}</strong>
            </span>
            <Link to={storeId === null ? '/receivables' : `/receivables?storeId=${storeId}`}>
              {t('receivables.tile.open')}
            </Link>
          </div>
        </>
      )}
    </Card>
  );
}
