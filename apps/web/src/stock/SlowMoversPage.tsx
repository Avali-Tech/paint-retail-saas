import {
  Card,
  EmptyState,
  Field,
  Icon,
  PageHeader,
  Pagination,
  Select,
  Table,
  buttonStyle,
} from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { SectionNav } from '../lib/SectionNav.js';
import { productTitle, variantName } from '../lib/product-title.js';
import { STOCK_SECTIONS } from './sections.js';
import { StoreSelect } from './StoreSelect.js';

export const PAGE_SIZE = 100;

/** How long without a sale or transfer out counts as slow; 45 days is the usual nudge. */
export const IDLE_WINDOWS = [45, 90, 180, 365] as const;
const DEFAULT_WINDOW = IDLE_WINDOWS[0];

const windowOf = (value: string): number => {
  const days = Number(value);
  return (IDLE_WINDOWS as readonly number[]).includes(days) ? days : DEFAULT_WINDOW;
};

/** /stock/slow-movers — stock that has sat unsold, the most money tied up first. */
export function SlowMoversPage() {
  const api = useApi();
  const { t, plural, number, money, date } = useI18n();
  const can = usePermissions();
  // The money tied up is at cost: shown only with costs:read.
  const costs = can('costs:read');
  const filters = useUrlFilters(['store', 'days'] as const);
  const { store } = filters.values;
  const days = windowOf(filters.values.days);
  const slow = useQuery({
    queryKey: ['slow-movers', store, days, filters.offset],
    queryFn: ({ signal }) =>
      api.stock.slowMovers(
        { storeId: store || undefined, days, limit: PAGE_SIZE, offset: filters.offset },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title={t('stock.slowMovers.title')}
        description={t('stock.slowMovers.description')}
      />
      <SectionNav label="stock.sections.label" links={STOCK_SECTIONS} />
      <Card>
        <div className="filters">
          <StoreSelect
            label={t('stock.store')}
            emptyLabel={t('stock.allStores')}
            value={store}
            onChange={(value) => {
              filters.set('store', value);
            }}
          />
          <Field label={t('stock.slowMovers.window')}>
            <Select
              value={String(days)}
              onChange={(event) => {
                filters.set(
                  'days',
                  Number(event.target.value) === DEFAULT_WINDOW ? '' : event.target.value,
                );
              }}
            >
              {IDLE_WINDOWS.map((option) => (
                <option key={option} value={option}>
                  {plural('stock.slowMovers.days', option)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <QueryState query={slow} error="stock.slowMovers.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="check" size={32} />}
                title={t('stock.slowMovers.emptyTitle')}
                description={plural('stock.slowMovers.emptyDescription', days)}
              />
            ) : (
              <>
                <p className="muted">{plural('stock.slowMovers.count', page.total, { days })}</p>
                <Table label={t('stock.slowMovers.list')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('stock.product')}</th>
                      <th scope="col">{t('stock.store')}</th>
                      <th scope="col" className="ui-num">
                        {t('stock.onHand')}
                      </th>
                      <th scope="col" className="ui-num">
                        {t('stock.slowMovers.idle')}
                      </th>
                      <th scope="col">{t('stock.slowMovers.lastDemand')}</th>
                      <th scope="col">{t('stock.slowMovers.sellsAt')}</th>
                      {costs && (
                        <th scope="col" className="ui-num">
                          {t('stock.slowMovers.value')}
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((item) => (
                      <tr key={`${item.store.id}-${item.variant.id}`}>
                        <th scope="row">
                          {productTitle(item.brand.name, item.product.name)}
                          <span className="cell-meta">
                            {item.variant.sku} · {variantName(item.variant)}
                          </span>
                        </th>
                        <td>{item.store.code}</td>
                        <td className="ui-num">{number(item.onHand)}</td>
                        <td className="ui-num">{plural('stock.slowMovers.days', item.daysIdle)}</td>
                        <td>
                          {item.lastDemandAt === null
                            ? t('stock.slowMovers.never')
                            : date(item.lastDemandAt)}
                        </td>
                        <td>
                          {item.sellsAt === null ? (
                            t('stock.slowMovers.sellsNowhere')
                          ) : (
                            <>
                              {t('stock.slowMovers.sold', {
                                store: item.sellsAt.store.code,
                                count: number(item.sellsAt.soldQuantity),
                              })}
                              {can('inventory:manage') && (
                                <span className="cell-meta">
                                  <Link
                                    to={`/transfers/new?${new URLSearchParams({
                                      from: item.store.id,
                                      to: item.sellsAt.store.id,
                                      product: item.productId,
                                      variant: item.variant.id,
                                      quantity: String(item.onHand),
                                    }).toString()}`}
                                  >
                                    {t('stock.slowMovers.moveTo', {
                                      store: item.sellsAt.store.code,
                                    })}
                                  </Link>
                                </span>
                              )}
                            </>
                          )}
                        </td>
                        {costs && (
                          <td className="ui-num">
                            {item.valuePaise === null
                              ? t('stock.slowMovers.noCost')
                              : money(item.valuePaise)}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('stock.slowMovers.pages')}
                  range={(from, to, total) => t('common.range', { from, to, total })}
                  previousLabel={t('common.previous')}
                  nextLabel={t('common.next')}
                />
                {can('inventory:manage') && (
                  <p className="muted">
                    {t('stock.slowMovers.moveHint')}{' '}
                    <Link to="/transfers/new" {...buttonStyle('secondary')}>
                      {t('stock.slowMovers.transfer')}
                    </Link>
                  </p>
                )}
              </>
            )
          }
        </QueryState>
      </Card>
    </>
  );
}
