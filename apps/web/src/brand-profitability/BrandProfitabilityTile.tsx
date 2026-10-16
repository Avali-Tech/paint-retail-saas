import { Card, Skeleton } from '@paint/ui';
import { BRAND_PROFITABILITY_PERMISSION } from '@paint/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';

/**
 * The dashboard's brand profitability tile (roadmap P2-M35): the brand that made the
 * most money last quarter, at the store the dashboard shows. Only for members who see
 * the books; its own request, so the rest of the dashboard never waits.
 */
export function BrandProfitabilityTile({ storeId }: { readonly storeId: string | null }) {
  const can = usePermissions();
  if (!can(BRAND_PROFITABILITY_PERMISSION)) return null;
  return <TopBrand storeId={storeId} />;
}

function TopBrand({ storeId }: { readonly storeId: string | null }) {
  const api = useApi();
  const { t, money, compactMoney, number } = useI18n();
  const filters = storeId === null ? {} : { storeId };
  const view = useQuery({
    queryKey: ['brand-profitability', filters],
    queryFn: ({ signal }) => api.brandProfitability.view(filters, signal),
  });
  const top = view.data?.brands[0];
  const link = storeId === null ? '' : `?storeId=${storeId}`;
  return (
    <Card className="tile">
      <h2 className="tile__title">{t('brandProfitability.tile.title')}</h2>
      {view.isError ? (
        <p className="muted">{t('brandProfitability.error')}</p>
      ) : view.data === undefined ? (
        <Skeleton className="tile__skeleton" />
      ) : (
        <>
          <p className="tile__value">
            {top === undefined ? t('brandProfitability.tile.none') : top.brandName}
          </p>
          <div className="tile__details">
            {top !== undefined && (
              <span className="figure">
                <span className="muted">{t('brandProfitability.columns.contribution')}</span>{' '}
                <strong title={money(top.figures.contributionPaise)}>
                  {compactMoney(top.figures.contributionPaise)}
                </strong>
                {top.figures.marginBps !== null && (
                  <span className="muted"> · {number(top.figures.marginBps / 100)}%</span>
                )}
              </span>
            )}
            <Link to={`/reports/brand-profitability${link}`}>
              {t('brandProfitability.tile.open')}
            </Link>
          </div>
        </>
      )}
    </Card>
  );
}
