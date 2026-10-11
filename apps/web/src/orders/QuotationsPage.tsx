import { ORDERS_PERMISSION, QUOTATION_STATUSES } from '@paint/shared';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  Select,
  Table,
  buttonStyle,
} from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useDebouncedValue, useUrlFilters } from '../lib/hooks.js';
import { ListPager, ListRefreshing } from '../lib/ListPager.js';
import { QueryState } from '../lib/QueryState.js';
import { PAGE_SIZE, QUOTATION_TONE } from './status.js';

/** Waits for typing to pause before searching (as the MVP 1 lists do). */
const SEARCH_DELAY_MS = 300;
const FILTERS = ['status', 'q'] as const;

/** /quotations — each quote's latest version, newest first. */
export function QuotationsPage() {
  const api = useApi();
  const can = usePermissions();
  const { t, label, money, date } = useI18n();
  const filters = useUrlFilters(FILTERS);
  const status = QUOTATION_STATUSES.find((value) => value === filters.values.status);
  const q = useDebouncedValue(filters.values.q.trim(), SEARCH_DELAY_MS);
  const quotations = useQuery({
    queryKey: ['quotations', { status, q, offset: filters.offset, cursor: filters.cursor }],
    queryFn: ({ signal }) =>
      api.orders.quotations(
        {
          status,
          q: q === '' ? undefined : q,
          limit: PAGE_SIZE,
          offset: filters.offset,
          cursor: filters.cursor,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title={t('orders.quotations.title')}
        description={t('orders.quotations.description')}
        actions={
          can(ORDERS_PERMISSION) ? (
            <Link to="/quotations/new" {...buttonStyle('primary')}>
              {t('orders.quotations.new')}
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
              {QUOTATION_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {label('quotationStatuses', value)}
                </option>
              ))}
            </Select>
          </Field>
          <ListRefreshing query={quotations} />
        </div>
        <QueryState query={quotations} error="orders.quotations.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="search" size={32} />}
                title={t('orders.quotations.empty')}
              />
            ) : (
              <>
                <Table label={t('orders.quotations.title')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('orders.list.number')}</th>
                      <th scope="col">{t('orders.list.customer')}</th>
                      <th scope="col">{t('orders.list.validUntil')}</th>
                      <th scope="col">{t('orders.list.total')}</th>
                      <th scope="col">{t('orders.list.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((quote) => (
                      <tr key={quote.id}>
                        <th scope="row">
                          <Link to={`/quotations/${quote.id}`}>{quote.number}</Link>
                          <span className="cell-meta">
                            {t('orders.quotation.version', { version: quote.version })}
                          </span>
                        </th>
                        <td>{quote.billToName}</td>
                        <td>{date(quote.validUntil)}</td>
                        <td>{money(quote.totalPaise)}</td>
                        <td>
                          <Badge tone={QUOTATION_TONE[quote.status]}>
                            {label('quotationStatuses', quote.status)}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <ListPager
                  filters={filters}
                  page={page}
                  limit={PAGE_SIZE}
                  label={t('orders.quotations.pages')}
                />
              </>
            )
          }
        </QueryState>
      </Card>
    </>
  );
}
