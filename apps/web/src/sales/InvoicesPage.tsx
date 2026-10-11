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
  type Tone,
} from '@paint/ui';
import { TAX_DOCUMENT_STATUSES, type TaxDocumentStatus } from '@paint/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { useDebouncedValue, useUrlFilters } from '../lib/hooks.js';
import { isDate } from '../lib/india-time.js';
import { ListPager, ListRefreshing } from '../lib/ListPager.js';
import { QueryState } from '../lib/QueryState.js';

export const PAGE_SIZE = 50;
/** Waits for typing to pause before searching (as the MVP 1 lists do). */
const SEARCH_DELAY_MS = 300;
const FILTERS = ['status', 'q', 'from', 'to'] as const;

export const STATUS_TONE: Record<TaxDocumentStatus, Tone> = {
  draft: 'neutral',
  issued: 'success',
  cancelled: 'danger',
};

/** /invoices — tax invoices and bills of supply, read-only; each opens its returns and notes. */
export function InvoicesPage() {
  const api = useApi();
  const { t, label, money, date } = useI18n();
  const filters = useUrlFilters(FILTERS);
  const status = TAX_DOCUMENT_STATUSES.find((value) => value === filters.values.status);
  const q = useDebouncedValue(filters.values.q.trim(), SEARCH_DELAY_MS);
  const from = isDate(filters.values.from) ? filters.values.from : undefined;
  const to = isDate(filters.values.to) ? filters.values.to : undefined;

  const invoices = useQuery({
    queryKey: ['invoices', { status, q, from, to, offset: filters.offset, cursor: filters.cursor }],
    queryFn: ({ signal }) =>
      api.sales.invoices(
        {
          status,
          q: q === '' ? undefined : q,
          from,
          to,
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
      <PageHeader title={t('sales.invoices.title')} description={t('sales.invoices.description')} />
      <Card>
        <div className="filters">
          <Field label={t('sales.invoices.search')} className="filters__search">
            <Input
              type="search"
              value={filters.values.q}
              onChange={(event) => {
                filters.set('q', event.target.value);
              }}
            />
          </Field>
          <Field label={t('sales.invoices.status')}>
            <Select
              value={status ?? ''}
              onChange={(event) => {
                filters.set('status', event.target.value);
              }}
            >
              <option value="">{t('sales.invoices.all')}</option>
              {TAX_DOCUMENT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {label('taxDocumentStatuses', value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('sales.invoices.from')}>
            <Input
              type="date"
              value={filters.values.from}
              onChange={(event) => {
                filters.set('from', event.target.value);
              }}
            />
          </Field>
          <Field label={t('sales.invoices.to')}>
            <Input
              type="date"
              value={filters.values.to}
              onChange={(event) => {
                filters.set('to', event.target.value);
              }}
            />
          </Field>
          <ListRefreshing query={invoices} />
        </div>
        <QueryState query={invoices} error="sales.invoices.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="search" size={32} />}
                title={t('sales.invoices.empty')}
              />
            ) : (
              <>
                <Table label={t('sales.invoices.title')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('sales.invoices.number')}</th>
                      <th scope="col">{t('sales.invoices.date')}</th>
                      <th scope="col">{t('sales.invoices.buyer')}</th>
                      <th scope="col">{t('sales.invoices.total')}</th>
                      <th scope="col">{t('sales.invoices.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((invoice) => (
                      <tr key={invoice.id}>
                        <th scope="row">
                          <Link to={`/invoices/${invoice.id}`}>
                            {invoice.number ?? t('sales.invoices.draft')}
                          </Link>
                          <span className="cell-meta">
                            {label('taxDocumentKinds', invoice.kind)}
                          </span>
                        </th>
                        <td>
                          {invoice.issuedOn === null ? t('common.none') : date(invoice.issuedOn)}
                        </td>
                        <td>{invoice.buyerName ?? t('common.none')}</td>
                        <td>{money(invoice.totalPaise)}</td>
                        <td>
                          <Badge tone={STATUS_TONE[invoice.status]}>
                            {label('taxDocumentStatuses', invoice.status)}
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
                  label={t('sales.invoices.pages')}
                />
              </>
            )
          }
        </QueryState>
      </Card>
    </>
  );
}
