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
} from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useI18n } from '../i18n/i18n.js';
import { useDebouncedValue, useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { SEARCH_DELAY_MS } from '../shell/SearchBox.js';
import type { TenantStatus } from './platform-api.js';
import { PLATFORM_QUERY, usePlatformApi } from './session.js';
import { Usage } from './usage.js';

export const TENANT_PAGE_SIZE = 50;
const FILTERS = ['q', 'status'] as const;
const STATUSES: readonly TenantStatus[] = ['active', 'suspended'];

/** /platform/tenants — every business with its plan, status and usage against the plan's limits. */
export function TenantsPage() {
  const { t, date, dateTime } = useI18n();
  const api = usePlatformApi();
  const filters = useUrlFilters(FILTERS);
  const q = useDebouncedValue(filters.values.q.trim(), SEARCH_DELAY_MS);
  const status = STATUSES.find((value) => value === filters.values.status);
  const tenants = useQuery({
    queryKey: [PLATFORM_QUERY, 'tenants', { q, status, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.tenants(
        {
          ...(q === '' ? {} : { q }),
          ...(status ? { status } : {}),
          limit: TENANT_PAGE_SIZE,
          offset: filters.offset,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title={t('platform.tenants.title')}
        description={t('platform.tenants.description')}
      />
      <Card>
        <div className="filters">
          <Field label={t('platform.tenants.search')} className="filters__search">
            <Input
              type="search"
              value={filters.values.q}
              placeholder={t('platform.tenants.searchPlaceholder')}
              onChange={(event) => {
                filters.set('q', event.target.value);
              }}
            />
          </Field>
          <Field label={t('platform.tenants.status')}>
            <Select
              value={status ?? ''}
              onChange={(event) => {
                filters.set('status', event.target.value);
              }}
            >
              <option value="">{t('platform.tenants.statuses.all')}</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(`platform.tenants.statuses.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <QueryState query={tenants} error="platform.tenants.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="store" size={32} />}
                title={t('platform.tenants.empty')}
              />
            ) : (
              <>
                <Table label={t('platform.tenants.list')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('platform.tenants.name')}</th>
                      <th scope="col">{t('platform.tenants.plan')}</th>
                      <th scope="col">{t('platform.tenants.status')}</th>
                      <th scope="col">{t('platform.tenants.stores')}</th>
                      <th scope="col">{t('platform.tenants.members')}</th>
                      <th scope="col">{t('platform.tenants.lastSignIn')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((tenant) => (
                      <tr key={tenant.id}>
                        <th scope="row">
                          <Link to={`/platform/tenants/${tenant.id}`}>{tenant.name}</Link>
                          <span className="cell-meta">
                            {t('platform.tenants.created', { date: date(tenant.createdAt) })}
                          </span>
                        </th>
                        <td>{tenant.plan.name}</td>
                        <td>
                          <Badge tone={tenant.status === 'active' ? 'success' : 'danger'}>
                            {t(`platform.tenants.statuses.${tenant.status}`)}
                          </Badge>
                        </td>
                        <td>
                          <Usage used={tenant.usage.stores} limit={tenant.plan.maxStores} />
                        </td>
                        <td>
                          <Usage used={tenant.usage.members} limit={tenant.plan.maxMembers} />
                        </td>
                        <td>
                          {tenant.usage.lastSignInAt === null
                            ? t('platform.tenants.never')
                            : dateTime(tenant.usage.lastSignInAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={TENANT_PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('platform.tenants.pages')}
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
