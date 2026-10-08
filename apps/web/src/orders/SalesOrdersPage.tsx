import { ORDERS_PERMISSION, SALES_ORDER_STATUSES } from '@paint/shared';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  Icon,
  Input,
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
import { ORDER_TONE, PAGE_SIZE } from './status.js';

const FILTERS = ['status', 'q'] as const;

/** /sales-orders — orders of the member's stores, newest first. */
export function SalesOrdersPage() {
  const api = useApi();
  const can = usePermissions();
  const { t, label, money, date } = useI18n();
  const filters = useUrlFilters(FILTERS);
  const status = SALES_ORDER_STATUSES.find((value) => value === filters.values.status);
  const q = filters.values.q.trim();
  const orders = useQuery({
    queryKey: ['sales-orders', { status, q, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.orders.orders(
        { status, q: q === '' ? undefined : q, limit: PAGE_SIZE, offset: filters.offset },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title={t('orders.orders.title')}
        description={t('orders.orders.description')}
        actions={
          can(ORDERS_PERMISSION) ? (
            <Link to="/sales-orders/new" {...buttonStyle('primary')}>
              {t('orders.orders.new')}
            </Link>
          ) : undefined
        }
      />
      <Card>
        <div className="filters">
          <Field label={t('orders.list.search')} className="filters__search">
            <Input
              type="search"
              value={filters.values.q}
              onChange={(event) => {
                filters.set('q', event.target.value);
              }}
            />
          </Field>
          <Field label={t('orders.list.status')}>
            <Select
              value={status ?? ''}
              onChange={(event) => {
                filters.set('status', event.target.value);
              }}
            >
              <option value="">{t('orders.list.all')}</option>
              {SALES_ORDER_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {label('salesOrderStatuses', value)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <QueryState query={orders} error="orders.orders.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="search" size={32} />}
                title={t('orders.orders.empty')}
              />
            ) : (
              <>
                <Table label={t('orders.orders.title')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('orders.list.number')}</th>
                      <th scope="col">{t('orders.list.customer')}</th>
                      <th scope="col">{t('orders.list.date')}</th>
                      <th scope="col">{t('orders.list.total')}</th>
                      <th scope="col">{t('orders.list.invoiced')}</th>
                      <th scope="col">{t('orders.list.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((order) => (
                      <tr key={order.id}>
                        <th scope="row">
                          <Link to={`/sales-orders/${order.id}`}>{order.number}</Link>
                          <span className="cell-meta">
                            {label('paymentTerms', order.paymentTerms)}
                          </span>
                        </th>
                        <td>{order.billToName}</td>
                        <td>{date(order.createdAt)}</td>
                        <td>{money(order.totalPaise)}</td>
                        <td>{money(order.invoicedPaise)}</td>
                        <td>
                          <Badge tone={ORDER_TONE[order.status]}>
                            {label('salesOrderStatuses', order.status)}
                          </Badge>
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
                  label={t('orders.orders.pages')}
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
