import { ESTIMATE_STATUSES, ESTIMATES_PERMISSION } from '@paint/shared';
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

const FILTERS = ['status', 'q'] as const;
const PAGE_SIZE = 50;

/** /estimates — paint estimates, newest first. */
export function EstimatesPage() {
  const api = useApi();
  const can = usePermissions();
  const { t, label, number } = useI18n();
  const filters = useUrlFilters(FILTERS);
  const status = ESTIMATE_STATUSES.find((value) => value === filters.values.status);
  const q = filters.values.q.trim();
  const estimates = useQuery({
    queryKey: ['estimate-list', { status, q, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.estimator.estimates(
        { status, q: q === '' ? undefined : q, limit: PAGE_SIZE, offset: filters.offset },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title={t('estimator.list.title')}
        description={t('estimator.list.description')}
        actions={
          can(ESTIMATES_PERMISSION) ? (
            <Link to="/estimates/new" {...buttonStyle('primary')}>
              {t('estimator.list.new')}
            </Link>
          ) : undefined
        }
      />
      <Card>
        <div className="filters">
          <Field label={t('estimator.list.search')} className="filters__search">
            <Input
              type="search"
              value={filters.values.q}
              onChange={(event) => {
                filters.set('q', event.target.value);
              }}
            />
          </Field>
          <Field label={t('estimator.list.status')}>
            <Select
              value={status ?? ''}
              onChange={(event) => {
                filters.set('status', event.target.value);
              }}
            >
              <option value="">{t('estimator.list.all')}</option>
              {ESTIMATE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {label('estimateStatuses', value)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <QueryState query={estimates} error="estimator.list.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="search" size={32} />}
                title={t('estimator.list.empty')}
              />
            ) : (
              <>
                <Table label={t('estimator.list.title')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('estimator.list.number')}</th>
                      <th scope="col">{t('estimator.list.customer')}</th>
                      <th scope="col">{t('estimator.list.name')}</th>
                      <th scope="col">{t('estimator.list.area')}</th>
                      <th scope="col">{t('estimator.list.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((estimate) => (
                      <tr key={estimate.id}>
                        <th scope="row">
                          <Link to={`/estimates/${estimate.id}`}>{estimate.number}</Link>
                        </th>
                        <td>{estimate.partyName ?? '—'}</td>
                        <td>{estimate.title ?? '—'}</td>
                        <td>
                          {t('estimator.list.areaValue', {
                            area: number(estimate.totalNetAreaSqft),
                          })}
                        </td>
                        <td>
                          <Badge tone={estimate.status === 'converted' ? 'success' : 'neutral'}>
                            {label('estimateStatuses', estimate.status)}
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
                  label={t('estimator.list.pages')}
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
