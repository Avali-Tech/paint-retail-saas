import { Card, EmptyState, Field, Icon, PageHeader, Pagination, Select, Table } from '@paint/ui';
import { PAYMENT_LINK_STATUSES } from '@paint/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { LinkActions, LinkStatus } from './PaymentLinks.js';

export const PAYMENT_LINKS_PAGE_SIZE = 25;
const FILTERS = ['status'] as const;

/** /payment-links — the UPI links sent from the stores the member works at, newest first. */
export function PaymentLinksPage() {
  const api = useApi();
  const { t, label, money, dateTime, number } = useI18n();
  const filters = useUrlFilters(FILTERS);
  const status = PAYMENT_LINK_STATUSES.find((value) => value === filters.values.status);
  const query = { status, limit: PAYMENT_LINKS_PAGE_SIZE, offset: filters.offset };
  const links = useQuery({
    queryKey: ['payment-links', query],
    queryFn: ({ signal }) => api.paymentLinks.list(query, signal),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader title={t('paymentLinks.title')} description={t('paymentLinks.description')} />
      <Card>
        <div className="filters">
          <Field label={t('paymentLinks.status')}>
            <Select
              value={status ?? ''}
              onChange={(event) => {
                filters.set('status', event.target.value);
              }}
            >
              <option value="">{t('paymentLinks.allStatuses')}</option>
              {PAYMENT_LINK_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {label('paymentLinkStatus', value)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>
      <QueryState query={links} error="paymentLinks.error">
        {(page) =>
          page.total === 0 ? (
            <EmptyState icon={<Icon name="search" size={32} />} title={t('paymentLinks.none')} />
          ) : (
            <Card>
              <div className="stack">
                <Table label={t('paymentLinks.table')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('paymentLinks.number')}</th>
                      <th scope="col">{t('paymentLinks.customer')}</th>
                      <th scope="col">{t('paymentLinks.purpose')}</th>
                      <th scope="col" className="numeric">
                        {t('paymentLinks.amount')}
                      </th>
                      <th scope="col" className="numeric">
                        {t('paymentLinks.paid')}
                      </th>
                      <th scope="col">{t('paymentLinks.status')}</th>
                      <th scope="col">{t('paymentLinks.expires')}</th>
                      <th scope="col">{t('paymentLinks.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((link) => (
                      <tr key={link.id}>
                        <th scope="row">{link.number}</th>
                        <td>
                          <Link to={`/parties/${link.partyId}`}>{link.partyName}</Link>
                        </td>
                        <td>{label('paymentLinkPurpose', link.purpose)}</td>
                        <td className="numeric">{money(link.amountPaise)}</td>
                        <td className="numeric">{money(link.paidPaise)}</td>
                        <td>
                          <LinkStatus link={link} />
                        </td>
                        <td>{dateTime(link.expiresAt)}</td>
                        <td>
                          <LinkActions link={link} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={PAYMENT_LINKS_PAGE_SIZE}
                  total={page.total}
                  onChange={(offset) => {
                    filters.setOffset(offset);
                  }}
                  label={t('paymentLinks.pages')}
                  range={(from, to, all) =>
                    t('common.range', { from: number(from), to: number(to), total: number(all) })
                  }
                  previousLabel={t('common.previous')}
                  nextLabel={t('common.next')}
                />
              </div>
            </Card>
          )
        }
      </QueryState>
    </>
  );
}
