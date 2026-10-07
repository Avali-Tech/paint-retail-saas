import {
  Card,
  Checkbox,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  Pagination,
  Table,
  buttonStyle,
} from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useDebouncedValue, useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { SectionNav } from '../lib/SectionNav.js';
import { STOCK_SECTIONS } from './sections.js';
import { StoreSelect } from './StoreSelect.js';
import { productTitle, variantName } from '../lib/product-title.js';

export const PAGE_SIZE = 50;
const FILTERS = ['store', 'q', 'inStock'] as const;

/** Stock on hand, reserved and available, per store and pack size. */
export function StockPage() {
  const api = useApi();
  const { t, number, money } = useI18n();
  const can = usePermissions();
  const filters = useUrlFilters(FILTERS);
  const { store, inStock } = filters.values;
  const q = useDebouncedValue(filters.values.q.trim(), 300);
  const filtered = q !== '' || store !== '' || inStock !== '';
  const stock = useQuery({
    queryKey: ['stock', { store, q, inStock, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.stock.balances(
        {
          storeId: store || undefined,
          q: q || undefined,
          inStockOnly: inStock === '1',
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
        title={t('stock.title')}
        description={t('stock.description')}
        actions={
          can('inventory:manage') ? (
            <>
              <Link to="/imports?kind=opening-stock" {...buttonStyle('secondary')}>
                {t('workflow.importData')}
              </Link>
              <Link
                to={store === '' ? '/stock/movements/new' : `/stock/movements/new?store=${store}`}
                {...buttonStyle()}
              >
                {t('stock.record')}
              </Link>
            </>
          ) : undefined
        }
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
          <Field label={t('stock.search')} className="filters__search">
            <Input
              type="search"
              value={filters.values.q}
              onChange={(event) => {
                filters.set('q', event.target.value);
              }}
            />
          </Field>
          <Checkbox
            label={t('stock.inStockOnly')}
            checked={inStock === '1'}
            onChange={(event) => {
              filters.set('inStock', event.target.checked ? '1' : '');
            }}
          />
        </div>
        <QueryState query={stock} error="stock.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="stock" size={32} />}
                title={filtered ? t('stock.noMatches') : t('stock.emptyTitle')}
                {...(filtered ? {} : { description: t('stock.emptyDescription') })}
              />
            ) : (
              <>
                <Table label={t('stock.list')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('stock.product')}</th>
                      <th scope="col">{t('stock.store')}</th>
                      <th scope="col" className="ui-num">
                        {t('stock.onHand')}
                      </th>
                      <th scope="col" className="ui-num">
                        {t('stock.reserved')}
                      </th>
                      <th scope="col" className="ui-num">
                        {t('stock.available')}
                      </th>
                      <th scope="col" className="ui-num">
                        {t('stock.value')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((row) => (
                      <tr key={`${row.store.id}-${row.variant.id}`}>
                        <th scope="row">
                          <Link to={`/products/${row.product.id}`}>
                            {productTitle(row.brand.name, row.product.name)}
                          </Link>
                          <span className="cell-meta">
                            {row.variant.sku} · {variantName(row.variant)}
                          </span>
                        </th>
                        <td>{row.store.code}</td>
                        <td className="ui-num">{number(row.onHand)}</td>
                        <td className="ui-num">{number(row.reserved)}</td>
                        <td className="ui-num">{number(row.available)}</td>
                        <td className="ui-num">
                          {row.valuePaise === null ? t('common.none') : money(row.valuePaise)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('stock.pages')}
                  range={(from, to, total) => t('common.range', { from, to, total })}
                  previousLabel={t('common.previous')}
                  nextLabel={t('common.next')}
                />
              </>
            )
          }
        </QueryState>
      </Card>
    </>
  );
}
