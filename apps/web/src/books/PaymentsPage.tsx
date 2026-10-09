import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  Select,
  Table,
} from '@paint/ui';
import { PAYMENT_DIRECTIONS, type PaymentSummary } from '@paint/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { saveFile } from '../lib/download.js';
import { useDebouncedValue, useUrlFilters } from '../lib/hooks.js';
import { isDate } from '../lib/india-time.js';
import { ListPager, ListRefreshing } from '../lib/ListPager.js';
import { QueryState } from '../lib/QueryState.js';

export const PAYMENTS_PAGE_SIZE = 50;
const FILTERS = ['direction', 'from', 'to', 'q'] as const;

/** Downloads one receipt as a PDF; a failure shows above the list. */
function ReceiptButton({
  payment,
  onError,
}: {
  readonly payment: PaymentSummary;
  readonly onError: (message: string | null) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={pending}
      aria-label={t('books.payments.pdfOf', { number: payment.number })}
      onClick={() => {
        setPending(true);
        onError(null);
        api.books
          .receiptPdf(payment.id)
          .then((file) => {
            saveFile(file.blob, file.fileName ?? `${payment.number}.pdf`);
          })
          .catch((error: unknown) => {
            onError(errorMessage(error));
          })
          .finally(() => {
            setPending(false);
          });
      }}
    >
      {t('books.payments.pdf')}
    </Button>
  );
}

/** /payments — money received and refunded, each with its receipt as a PDF. */
export function PaymentsPage() {
  const api = useApi();
  const { t, label, money, date } = useI18n();
  const filters = useUrlFilters(FILTERS);
  const direction = PAYMENT_DIRECTIONS.find((value) => value === filters.values.direction);
  const from = isDate(filters.values.from) ? filters.values.from : undefined;
  const to = isDate(filters.values.to) ? filters.values.to : undefined;
  const q = useDebouncedValue(filters.values.q.trim(), 300);
  const [message, setMessage] = useState<string | null>(null);
  const payments = useQuery({
    queryKey: [
      'payments',
      { direction, from, to, q, offset: filters.offset, cursor: filters.cursor },
    ],
    queryFn: ({ signal }) =>
      api.books.payments(
        {
          direction,
          from,
          to,
          q: q === '' ? undefined : q,
          limit: PAYMENTS_PAGE_SIZE,
          offset: filters.offset,
          cursor: filters.cursor,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader title={t('books.payments.title')} description={t('books.payments.description')} />
      <Card>
        <div className="stack">
          <div className="filters">
            <Field label={t('books.payments.search')} className="filters__search">
              <Input
                type="search"
                value={filters.values.q}
                onChange={(event) => {
                  filters.set('q', event.target.value);
                }}
              />
            </Field>
            <Field label={t('books.payments.direction')}>
              <Select
                value={direction ?? ''}
                onChange={(event) => {
                  filters.set('direction', event.target.value);
                }}
              >
                <option value="">{t('books.payments.all')}</option>
                {PAYMENT_DIRECTIONS.map((value) => (
                  <option key={value} value={value}>
                    {label('paymentDirections', value)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('books.payments.from')}>
              <Input
                type="date"
                value={filters.values.from}
                onChange={(event) => {
                  filters.set('from', event.target.value);
                }}
              />
            </Field>
            <Field label={t('books.payments.to')}>
              <Input
                type="date"
                value={filters.values.to}
                onChange={(event) => {
                  filters.set('to', event.target.value);
                }}
              />
            </Field>
            <ListRefreshing query={payments} />
          </div>
          {message !== null && <Alert tone="danger">{message}</Alert>}
          <QueryState query={payments} error="books.payments.error">
            {(page) =>
              page.items.length === 0 ? (
                <EmptyState
                  icon={<Icon name="search" size={32} />}
                  title={t('books.payments.empty')}
                />
              ) : (
                <>
                  <Table label={t('books.payments.title')}>
                    <thead>
                      <tr>
                        <th scope="col">{t('books.payments.number')}</th>
                        <th scope="col">{t('books.payments.date')}</th>
                        <th scope="col">{t('books.payments.party')}</th>
                        <th scope="col">{t('books.payments.mode')}</th>
                        <th scope="col">{t('books.payments.amount')}</th>
                        <th scope="col">{t('books.payments.receipt')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.items.map((payment) => (
                        <tr key={payment.id}>
                          <th scope="row">
                            {payment.number}
                            <span className="cell-meta">
                              {payment.voucherNumber ??
                                label('paymentDirections', payment.direction)}
                            </span>
                          </th>
                          <td>{date(payment.receivedOn)}</td>
                          <td>{payment.partyName}</td>
                          <td>
                            {payment.modeName}
                            {payment.chequeStatus !== null && (
                              <Badge tone={payment.chequeStatus === 'bounced' ? 'danger' : 'info'}>
                                {label('chequeStatuses', payment.chequeStatus)}
                              </Badge>
                            )}
                          </td>
                          <td>{money(payment.amountPaise)}</td>
                          <td>
                            <ReceiptButton payment={payment} onError={setMessage} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  <ListPager
                    filters={filters}
                    page={page}
                    limit={PAYMENTS_PAGE_SIZE}
                    label={t('books.payments.pages')}
                  />
                </>
              )
            }
          </QueryState>
        </div>
      </Card>
    </>
  );
}
