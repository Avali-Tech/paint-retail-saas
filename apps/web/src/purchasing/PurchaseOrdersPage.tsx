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
import { PURCHASE_ORDER_STATUSES, type PurchaseOrderStatus } from '../api/purchasing.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { SectionNav } from '../lib/SectionNav.js';
import { StoreSelect } from '../stock/StoreSelect.js';
import { PURCHASING_SECTIONS } from './sections.js';
import { OrderStatusBadge, SupplierSelect } from './shared.js';

export const PAGE_SIZE = 50;
const FILTERS = ['status', 'store', 'supplier'] as const;

const isStatus = (value: string): value is PurchaseOrderStatus =>
  (PURCHASE_ORDER_STATUSES as readonly string[]).includes(value);

/** /purchase-orders — what has been ordered and what is still due. */
export function PurchaseOrdersPage() {
  const api = useApi();
  const { t, label, money, number, date } = useI18n();
  const can = usePermissions();
  const filters = useUrlFilters(FILTERS);
  const { status, store, supplier } = filters.values;
  const filtered = status !== '' || store !== '' || supplier !== '';
  const orders = useQuery({
    queryKey: ['purchase-orders', { status, store, supplier, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.purchasing.orders(
        {
          ...(isStatus(status) ? { status } : {}),
          storeId: store || undefined,
          supplierId: supplier || undefined,
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
        title={t('purchasing.orderList.title')}
        description={t('purchasing.orderList.description')}
        actions={
          can('purchasing:manage') ? (
            <>
              {can('inventory:read') && (
                <Link to="/stock/low" {...buttonStyle('secondary')}>
                  {t('purchasing.orderList.fromLowStock')}
                </Link>
              )}
              <Link to="/purchase-orders/new" {...buttonStyle()}>
                {t('purchasing.orderList.new')}
              </Link>
            </>
          ) : undefined
        }
      />
      <SectionNav label="purchasing.sections" links={PURCHASING_SECTIONS} />
      <Card>
        <div className="filters">
          <Field label={t('purchasing.status')}>
            <Select
              value={status}
              onChange={(event) => {
                filters.set('status', event.target.value);
              }}
            >
              <option value="">{t('purchasing.allStatuses')}</option>
              {PURCHASE_ORDER_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {label('purchaseOrderStatus', value)}
                </option>
              ))}
            </Select>
          </Field>
          <StoreSelect
            label={t('purchasing.store')}
            value={store}
            emptyLabel={t('purchasing.allStores')}
            onChange={(value) => {
              filters.set('store', value);
            }}
          />
          <SupplierSelect
            label={t('purchasing.supplier')}
            value={supplier}
            emptyLabel={t('purchasing.allSuppliers')}
            onChange={(value) => {
              filters.set('supplier', value);
            }}
          />
        </div>
        <QueryState query={orders} error="purchasing.orderList.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="purchasing" size={32} />}
                title={
                  filtered
                    ? t('purchasing.orderList.noMatches')
                    : t('purchasing.orderList.emptyTitle')
                }
                {...(filtered ? {} : { description: t('purchasing.orderList.emptyDescription') })}
              />
            ) : (
              <>
                <Table label={t('purchasing.orderList.list')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('purchasing.orderList.number')}</th>
                      <th scope="col">{t('purchasing.supplier')}</th>
                      <th scope="col">{t('purchasing.store')}</th>
                      <th scope="col">{t('purchasing.status')}</th>
                      <th scope="col">{t('purchasing.orderList.expected')}</th>
                      <th scope="col" className="ui-num">
                        {t('purchasing.orderList.lines')}
                      </th>
                      <th scope="col" className="ui-num">
                        {t('purchasing.value')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((order) => (
                      <tr key={order.id}>
                        <th scope="row">
                          <Link to={`/purchase-orders/${order.id}`}>{order.number}</Link>
                          <span className="cell-meta">{date(order.createdAt)}</span>
                        </th>
                        <td>{order.supplier.name}</td>
                        <td>{order.store.code}</td>
                        <td>
                          <OrderStatusBadge status={order.status} />
                        </td>
                        <td>
                          {order.expectedDate === null
                            ? t('common.none')
                            : date(order.expectedDate)}
                        </td>
                        <td className="ui-num">{number(order.lineCount)}</td>
                        <td className="ui-num">{money(order.totalValuePaise)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('purchasing.orderList.pages')}
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
