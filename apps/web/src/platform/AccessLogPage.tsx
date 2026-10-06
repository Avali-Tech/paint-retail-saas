import { Card, EmptyState, Field, Icon, PageHeader, Select, Table } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { grantLength } from '../support-access/grants.js';
import type { GrantStatus, GrantView } from './platform-api.js';
import { usePlatformApi } from './session.js';
import { GrantStatusBadge, grantsKey } from './support-ui.js';

const STATUSES: readonly GrantStatus[] = ['pending', 'active', 'declined', 'expired', 'ended'];
const FILTERS = ['status'] as const;

/** When the business decided, if it has. */
const decidedAt = (grant: GrantView) => grant.approvedAt ?? grant.declinedAt;
/** When access stopped: ended early, or ran out. */
const finishedAt = (grant: GrantView) =>
  grant.endedAt ?? (grant.status === 'expired' ? grant.expiresAt : null);

/**
 * /platform/access-log — every support access request across businesses, newest
 * first. What support looked at during access is shown to the business itself.
 */
export function AccessLogPage() {
  const { t, dateTime } = useI18n();
  const api = usePlatformApi();
  const filters = useUrlFilters(FILTERS);
  const status = STATUSES.find((value) => value === filters.values.status);
  const grants = useQuery({
    queryKey: grantsKey(),
    queryFn: ({ signal }) => api.grants(undefined, signal),
  });
  const when = (iso: string | null) => (iso === null ? t('common.none') : dateTime(iso));
  return (
    <>
      <PageHeader title={t('platform.log.title')} description={t('platform.log.description')} />
      <Card>
        <div className="filters">
          <Field label={t('platform.log.status')}>
            <Select
              value={status ?? ''}
              onChange={(event) => {
                filters.set('status', event.target.value);
              }}
            >
              <option value="">{t('platform.log.all')}</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(`platform.support.statuses.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <QueryState query={grants} error="platform.support.error">
          {(all) => {
            const shown = all.filter((grant) => status === undefined || grant.status === status);
            return shown.length === 0 ? (
              <EmptyState icon={<Icon name="lock" size={32} />} title={t('platform.log.empty')} />
            ) : (
              <Table label={t('platform.log.title')}>
                <thead>
                  <tr>
                    <th scope="col">{t('platform.support.business')}</th>
                    <th scope="col">{t('platform.support.requestedBy')}</th>
                    <th scope="col">{t('platform.support.why')}</th>
                    <th scope="col">{t('platform.support.length')}</th>
                    <th scope="col">{t('platform.support.status')}</th>
                    <th scope="col">{t('platform.support.requestedAt')}</th>
                    <th scope="col">{t('platform.log.decided')}</th>
                    <th scope="col">{t('platform.log.finished')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((grant) => (
                    <tr key={grant.id}>
                      <th scope="row">
                        <Link to={`/platform/tenants/${grant.organization.id}`}>
                          {grant.organization.name}
                        </Link>
                      </th>
                      <td>{grant.requestedBy}</td>
                      <td>{grant.reason}</td>
                      <td>{grantLength(t, grant.minutes)}</td>
                      <td>
                        <GrantStatusBadge grant={grant} />
                      </td>
                      <td>{dateTime(grant.requestedAt)}</td>
                      <td>{when(decidedAt(grant))}</td>
                      <td>{when(finishedAt(grant))}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            );
          }}
        </QueryState>
      </Card>
    </>
  );
}
