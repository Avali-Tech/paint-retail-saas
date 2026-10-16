import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  PageHeader,
  Select,
  Skeleton,
  Table,
} from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import type { Dashboard, StageCount } from '../api/types.js';
import { useApi } from '../app/services.js';
import { stageLabel, useI18n } from '../i18n/i18n.js';
import { ReceivablesTile } from '../receivables/ReceivablesTile.js';
import { BrandProfitabilityTile } from '../brand-profitability/BrandProfitabilityTile.js';

export const dashboardKey = (storeId: string | null) => ['dashboard', storeId ?? 'all'] as const;

function Tile({
  title,
  value,
  children,
}: {
  readonly title: string;
  readonly value: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <Card className="tile">
      <h2 className="tile__title">{title}</h2>
      <p className="tile__value">{value}</p>
      {children !== undefined && <div className="tile__details">{children}</div>}
    </Card>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'danger' | 'warning';
}) {
  return (
    <span className="figure">
      <span className="muted">{label}</span>{' '}
      {tone === undefined ? <strong>{value}</strong> : <Badge tone={tone}>{value}</Badge>}
    </span>
  );
}

/**
 * Follow-ups counted as /follow-ups counts them: the team's for managers (and
 * the link opens "everyone", at the store chosen here), else the member's own.
 */
function FollowUpTile({
  followUps,
  storeId,
}: {
  readonly followUps: Dashboard['followUps'];
  readonly storeId: string | null;
}) {
  const { t, number } = useI18n();
  const team = followUps.scope === 'team';
  const query = new URLSearchParams(team ? { assignedTo: 'everyone' } : {});
  if (team && storeId !== null) query.set('storeId', storeId);
  const search = query.toString();
  return (
    <Tile
      title={t(team ? 'followUps.tile.team' : 'followUps.tile.mine')}
      value={number(followUps.overdue + followUps.today)}
    >
      <Figure
        label={t('dashboard.overdue')}
        value={number(followUps.overdue)}
        {...(followUps.overdue > 0 ? { tone: 'danger' as const } : {})}
      />
      <Figure label={t('dashboard.today')} value={number(followUps.today)} />
      <Link to={search === '' ? '/follow-ups' : `/follow-ups?${search}`}>
        {t(team ? 'followUps.tile.openTeam' : 'dashboard.openFollowUps')}
      </Link>
    </Tile>
  );
}

function Tiles({
  dashboard,
  storeId,
}: {
  readonly dashboard: Dashboard;
  readonly storeId: string | null;
}) {
  const { t, plural, number, compactMoney, money } = useI18n();
  const { stock, lowStock, transfers, purchaseOrders } = dashboard.totals;
  return (
    <section className="tiles" aria-label={t('dashboard.total')}>
      {stock && (
        <Tile
          title={t('dashboard.stockValue')}
          value={<span title={money(stock.valuePaise)}>{compactMoney(stock.valuePaise)}</span>}
        >
          <Figure label={t('dashboard.units')} value={number(stock.units)} />
          <span className="muted">{plural('dashboard.skus', stock.skus)}</span>
          {stock.uncostedSkus > 0 && (
            <Badge tone="warning">
              {t('dashboard.uncosted', { count: number(stock.uncostedSkus) })}
            </Badge>
          )}
        </Tile>
      )}
      {lowStock && (
        <Tile
          title={t('dashboard.lowStock')}
          value={number(lowStock.outOfStock + lowStock.belowMinimum + lowStock.reorder)}
        >
          <Figure
            label={t('dashboard.outOfStock')}
            value={number(lowStock.outOfStock)}
            tone="danger"
          />
          <Figure
            label={t('dashboard.belowMinimum')}
            value={number(lowStock.belowMinimum)}
            tone="warning"
          />
          <Figure label={t('dashboard.reorder')} value={number(lowStock.reorder)} />
        </Tile>
      )}
      {transfers && (
        <Tile
          title={t('dashboard.transfers')}
          value={number(transfers.awaitingApproval + transfers.toDispatch + transfers.incoming)}
        >
          <Figure
            label={t('dashboard.awaitingApproval')}
            value={number(transfers.awaitingApproval)}
          />
          <Figure label={t('dashboard.toDispatch')} value={number(transfers.toDispatch)} />
          <Figure label={t('dashboard.incoming')} value={number(transfers.incoming)} />
        </Tile>
      )}
      {purchaseOrders && (
        <Tile title={t('dashboard.purchaseOrders')} value={number(purchaseOrders.open)}>
          <Figure label={t('dashboard.dueValue')} value={money(purchaseOrders.dueValuePaise)} />
        </Tile>
      )}
      <FollowUpTile followUps={dashboard.followUps} storeId={storeId} />
      <ReceivablesTile storeId={storeId} />
      <BrandProfitabilityTile storeId={storeId} />
    </section>
  );
}

function StoresTable({ dashboard }: { readonly dashboard: Dashboard }) {
  const { t, number, money } = useI18n();
  const { totals } = dashboard;
  const cells = (row: Omit<Dashboard['stores'][number], 'store'>) => (
    <>
      {row.stock && (
        <>
          <td className="ui-num">{money(row.stock.valuePaise)}</td>
          <td className="ui-num">{number(row.stock.units)}</td>
          <td className="ui-num">{number(row.stock.skus)}</td>
        </>
      )}
      {row.lowStock && (
        <>
          <td className="ui-num">{number(row.lowStock.outOfStock)}</td>
          <td className="ui-num">{number(row.lowStock.belowMinimum)}</td>
        </>
      )}
      {row.transfers && <td className="ui-num">{number(row.transfers.incoming)}</td>}
      {row.purchaseOrders && (
        <>
          <td className="ui-num">{number(row.purchaseOrders.open)}</td>
          <td className="ui-num">{money(row.purchaseOrders.dueValuePaise)}</td>
        </>
      )}
    </>
  );
  return (
    <Card title={t('dashboard.stores')}>
      <Table label={t('dashboard.stores')}>
        <thead>
          <tr>
            <th scope="col">{t('dashboard.store')}</th>
            {totals.stock && (
              <>
                <th scope="col" className="ui-num">
                  {t('dashboard.stockValue')}
                </th>
                <th scope="col" className="ui-num">
                  {t('dashboard.units')}
                </th>
                <th scope="col" className="ui-num">
                  {t('dashboard.skuColumn')}
                </th>
              </>
            )}
            {totals.lowStock && (
              <>
                <th scope="col" className="ui-num">
                  {t('dashboard.outOfStock')}
                </th>
                <th scope="col" className="ui-num">
                  {t('dashboard.belowMinimum')}
                </th>
              </>
            )}
            {totals.transfers && (
              <th scope="col" className="ui-num">
                {t('dashboard.incoming')}
              </th>
            )}
            {totals.purchaseOrders && (
              <>
                <th scope="col" className="ui-num">
                  {t('dashboard.purchaseOrders')}
                </th>
                <th scope="col" className="ui-num">
                  {t('dashboard.dueValue')}
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {dashboard.stores.map((row) => (
            <tr key={row.store.id}>
              <th scope="row">
                <span className="store-code">{row.store.code}</span> {row.store.name}
              </th>
              {cells(row)}
            </tr>
          ))}
        </tbody>
        {dashboard.stores.length > 1 && (
          <tfoot>
            <tr>
              <th scope="row">{t('dashboard.total')}</th>
              {cells(totals)}
            </tr>
          </tfoot>
        )}
      </Table>
    </Card>
  );
}

function Pipeline({
  title,
  stages,
  weighted = false,
}: {
  readonly title: string;
  readonly stages: readonly (StageCount & { readonly weightedValuePaise?: number })[];
  readonly weighted?: boolean;
}) {
  const { t, number, money } = useI18n();
  const largest = Math.max(...stages.map((stage) => stage.count));
  return (
    <Card title={title} className="pipeline">
      {largest === 0 ? (
        <p className="muted">{t('dashboard.noPipeline')}</p>
      ) : (
        <Table label={title}>
          <thead>
            <tr>
              <th scope="col">{t('dashboard.stage')}</th>
              <th scope="col" className="ui-num">
                {t('dashboard.count')}
              </th>
              <th scope="col" className="ui-num">
                {t('dashboard.value')}
              </th>
              {weighted && (
                <th scope="col" className="ui-num">
                  {t('dashboard.weighted')}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {stages.map((stage, index) => (
              <tr key={stage.stage}>
                <th scope="row">
                  <span className="pipeline__stage">{stageLabel(t, stage.stage)}</span>
                  <span
                    className="pipeline__bar"
                    data-series={String((index % 6) + 1)}
                    style={{ inlineSize: `${String((stage.count / largest) * 100)}%` }}
                    aria-hidden="true"
                  />
                </th>
                <td className="ui-num">{number(stage.count)}</td>
                <td className="ui-num">{money(stage.valuePaise)}</td>
                {weighted && stage.weightedValuePaise !== undefined && (
                  <td className="ui-num">{money(stage.weightedValuePaise)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Loading() {
  return (
    <div className="tiles" aria-hidden="true">
      {[1, 2, 3, 4].map((key) => (
        <Card key={key} className="tile">
          <Skeleton width="40%" />
          <Skeleton height="2rem" width="60%" className="tile__skeleton" />
          <Skeleton width="80%" />
        </Card>
      ))}
    </div>
  );
}

/** The owner's view of every store: stock, low stock, transfers, orders, pipelines and follow-ups. */
export function DashboardPage() {
  const api = useApi();
  const { t, relativeTime } = useI18n();
  const [params, setParams] = useSearchParams();
  const storeId = params.get('store');
  const dashboard = useQuery({
    queryKey: dashboardKey(storeId),
    queryFn: ({ signal }) => api.dashboard(storeId ?? undefined, signal),
  });
  // The unfiltered dashboard lists every store for the picker (same query when not filtered).
  const everything = useQuery({
    queryKey: dashboardKey(null),
    queryFn: ({ signal }) => api.dashboard(undefined, signal),
  });
  const stores = everything.data?.stores.map((row) => row.store) ?? [];

  const data = dashboard.data;
  const storeCount = data?.stores.length ?? 0;
  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        description={
          data
            ? t('dashboard.updated', { time: relativeTime(data.generatedAt) })
            : t('dashboard.description')
        }
        actions={
          <>
            {stores.length > 1 && (
              <Field label={t('dashboard.store')} className="store-picker">
                <Select
                  value={storeId ?? ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    setParams(value === '' ? {} : { store: value });
                  }}
                >
                  <option value="">{t('dashboard.allStores')}</option>
                  {stores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.code} · {store.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Button
              variant="secondary"
              loading={dashboard.isFetching}
              onClick={() => {
                void dashboard.refetch();
              }}
            >
              <Icon name="refresh" size={16} />
              {t('dashboard.refresh')}
            </Button>
          </>
        }
      />
      {dashboard.isPending && <Loading />}
      {dashboard.isError && (
        <Alert
          tone="danger"
          title={t('dashboard.error')}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                void dashboard.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          }
        >
          {errorMessage(dashboard.error)}
        </Alert>
      )}
      {data !== undefined && storeCount === 0 && (
        <Card>
          <EmptyState
            icon={<Icon name="store" size={32} />}
            title={t('dashboard.emptyTitle')}
            description={t('dashboard.emptyDescription')}
          />
        </Card>
      )}
      {data !== undefined && storeCount > 0 && (
        <div className="dashboard">
          <Tiles dashboard={data} storeId={storeId} />
          <StoresTable dashboard={data} />
          <div className="pipelines">
            {data.leads && <Pipeline title={t('dashboard.leads')} stages={data.leads} />}
            {data.opportunities && (
              <Pipeline title={t('dashboard.opportunities')} stages={data.opportunities} weighted />
            )}
            {data.projects && <Pipeline title={t('dashboard.projects')} stages={data.projects} />}
          </div>
        </div>
      )}
    </>
  );
}
