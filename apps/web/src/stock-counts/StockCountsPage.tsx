import {
  Badge,
  Card,
  EmptyState,
  Field,
  Icon,
  PageHeader,
  Pagination,
  Select,
  Table,
  buttonStyle,
  type Tone,
} from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { COUNT_STATUSES, type CountStatus } from '../api/stock-counts.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { StoreSelect } from '../stock/StoreSelect.js';

export const PAGE_SIZE = 50;
const FILTERS = ['store', 'status'] as const;

/** How each count status is coloured. */
export const COUNT_TONE: Record<CountStatus, Tone> = {
  counting: 'info',
  submitted: 'warning',
  approved: 'success',
  cancelled: 'neutral',
};

/** Each store's accuracy at its last approved count. */
function Accuracy() {
  const api = useApi();
  const { t, plural, date, number } = useI18n();
  const accuracy = useQuery({
    queryKey: ['stock-counts', 'accuracy'],
    queryFn: ({ signal }) => api.stockCounts.accuracy(signal),
  });
  return (
    <Card title={t('stockCounts.accuracy.title')}>
      <QueryState query={accuracy} error="stockCounts.accuracy.error">
        {(stores) =>
          stores.length === 0 ? (
            <p className="muted">{t('stockCounts.accuracy.empty')}</p>
          ) : (
            <Table label={t('stockCounts.accuracy.list')}>
              <thead>
                <tr>
                  <th scope="col">{t('stockCounts.accuracy.store')}</th>
                  <th scope="col">{t('stockCounts.accuracy.lastCount')}</th>
                  <th scope="col" className="ui-num">
                    {t('stockCounts.accuracy.percent')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {stores.map(({ store, lastCount }) => (
                  <tr key={store.id}>
                    <th scope="row">
                      {store.code} · {store.name}
                    </th>
                    {lastCount === null ? (
                      <td colSpan={2} className="muted">
                        {t('stockCounts.accuracy.never')}
                      </td>
                    ) : (
                      <>
                        <td>
                          {lastCount.number} · {date(lastCount.approvedAt)}
                          <span className="cell-meta">
                            {plural('stockCounts.accuracy.counted', lastCount.countedLines)}
                          </span>
                        </td>
                        <td className="ui-num">
                          {lastCount.accuracyPercent === null
                            ? t('common.none')
                            : t('stockCounts.accuracy.percentValue', {
                                percent: number(lastCount.accuracyPercent),
                              })}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryState>
    </Card>
  );
}

/** /stock-counts — counts at the member's stores and how accurate each store's books are. */
export function StockCountsPage() {
  const api = useApi();
  const { t, label, date } = useI18n();
  const can = usePermissions();
  const filters = useUrlFilters(FILTERS);
  const { store, status } = filters.values;
  const filtered = store !== '' || status !== '';
  const counts = useQuery({
    queryKey: ['stock-counts', { store, status, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.stockCounts.list(
        {
          storeId: store || undefined,
          status: (status || undefined) as CountStatus | undefined,
          limit: PAGE_SIZE,
          offset: filters.offset,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title={t('stockCounts.title')}
        description={t('stockCounts.description')}
        actions={
          can('inventory:manage') ? (
            <Link to="/stock-counts/new" {...buttonStyle()}>
              {t('stockCounts.new')}
            </Link>
          ) : undefined
        }
      />
      <div className="stack">
        <Card>
          <div className="filters">
            <StoreSelect
              label={t('stockCounts.store')}
              value={store}
              emptyLabel={t('stockCounts.allStores')}
              onChange={(value) => {
                filters.set('store', value);
              }}
            />
            <Field label={t('stockCounts.status')}>
              <Select
                value={status}
                onChange={(event) => {
                  filters.set('status', event.target.value);
                }}
              >
                <option value="">{t('stockCounts.allStatuses')}</option>
                {COUNT_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {label('countStatus', value)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <QueryState query={counts} error="stockCounts.error">
            {(page) =>
              page.items.length === 0 ? (
                <EmptyState
                  icon={<Icon name="stock" size={32} />}
                  title={filtered ? t('stockCounts.noMatches') : t('stockCounts.emptyTitle')}
                  {...(filtered ? {} : { description: t('stockCounts.emptyDescription') })}
                />
              ) : (
                <>
                  <Table label={t('stockCounts.list')}>
                    <thead>
                      <tr>
                        <th scope="col">{t('stockCounts.number')}</th>
                        <th scope="col">{t('stockCounts.store')}</th>
                        <th scope="col">{t('stockCounts.scope')}</th>
                        <th scope="col">{t('stockCounts.status')}</th>
                        <th scope="col">{t('stockCounts.started')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.items.map((count) => (
                        <tr key={count.id}>
                          <th scope="row">
                            <Link to={`/stock-counts/${count.id}`}>{count.number}</Link>
                          </th>
                          <td>{count.store.code}</td>
                          <td>{label('countScope', count.scope)}</td>
                          <td>
                            <Badge tone={COUNT_TONE[count.status]}>
                              {label('countStatus', count.status)}
                            </Badge>
                          </td>
                          <td>{date(count.startedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  <Pagination
                    offset={filters.offset}
                    limit={PAGE_SIZE}
                    total={page.total}
                    onChange={filters.setOffset}
                    label={t('stockCounts.pages')}
                    range={(from, to, total) => t('common.range', { from, to, total })}
                    previousLabel={t('common.previous')}
                    nextLabel={t('common.next')}
                  />
                </>
              )
            }
          </QueryState>
        </Card>
        <Accuracy />
      </div>
    </>
  );
}
