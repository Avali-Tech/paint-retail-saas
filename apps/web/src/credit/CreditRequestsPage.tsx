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
  type Tone,
} from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { CREDIT_REQUEST_STATUSES, type CreditRequest } from '../api/credit.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { RequestDecision } from './RequestDecision.js';

export const PAGE_SIZE = 50;
const FILTERS = ['status'] as const;

export const REQUEST_TONE: Record<CreditRequest['status'], Tone> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
};

/** Credit requests, waiting ones first by default, for approvers to decide. */
export function CreditRequestsPage() {
  const api = useApi();
  const { t, plural, label, money, date } = useI18n();
  const can = usePermissions();
  const filters = useUrlFilters(FILTERS);
  // "all" (or anything unknown) shows every status.
  const chosen = filters.values.status || 'pending';
  const status = CREDIT_REQUEST_STATUSES.find((value) => value === chosen);
  const approver = can('credit:approve');

  const requests = useQuery({
    queryKey: ['credit-requests', { status, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.credit.requests({ status, limit: PAGE_SIZE, offset: filters.offset }, signal),
    placeholderData: keepPreviousData,
  });

  const terms = (limitPaise: number, creditDays: number) =>
    t('credit.terms', {
      limit: money(limitPaise),
      days: plural('credit.daysValue', creditDays),
    });

  return (
    <>
      <PageHeader
        title={t('credit.requests.title')}
        description={t('credit.requests.description')}
      />
      <Card>
        <div className="filters">
          <Field label={t('credit.requests.status')}>
            <Select
              value={chosen}
              onChange={(event) => {
                filters.set('status', event.target.value);
              }}
            >
              {CREDIT_REQUEST_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {label('creditRequestStatus', value)}
                </option>
              ))}
              <option value="all">{t('credit.requests.all')}</option>
            </Select>
          </Field>
        </div>
        <QueryState query={requests} error="credit.requests.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="check" size={32} />}
                title={t('credit.requests.empty')}
              />
            ) : (
              <>
                <Table label={t('credit.requests.title')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('credit.requests.number')}</th>
                      <th scope="col">{t('credit.requests.party')}</th>
                      <th scope="col">{t('credit.requests.asked')}</th>
                      <th scope="col">{t('credit.requests.previous')}</th>
                      <th scope="col">{t('credit.requests.requestedBy')}</th>
                      <th scope="col">{t('credit.requests.status')}</th>
                      {approver && <th scope="col">{t('credit.requests.decide')}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((request) => (
                      <tr key={request.id}>
                        <th scope="row">
                          <Link to={`/credit-requests/${request.id}`}>{request.number}</Link>
                        </th>
                        <td>
                          <Link to={`/parties/${request.party.id}`}>{request.party.name}</Link>
                        </td>
                        <td>{terms(request.limitPaise, request.creditDays)}</td>
                        <td>{terms(request.previousLimitPaise, request.previousCreditDays)}</td>
                        <td>
                          {request.requestedBy.name}
                          <span className="cell-meta">{date(request.createdAt)}</span>
                        </td>
                        <td>
                          <Badge tone={REQUEST_TONE[request.status]}>
                            {label('creditRequestStatus', request.status)}
                          </Badge>
                        </td>
                        {approver && (
                          <td>
                            {request.status === 'pending' && (
                              <span className="row">
                                <RequestDecision request={request} />
                              </span>
                            )}
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
                  label={t('credit.requests.pages')}
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
