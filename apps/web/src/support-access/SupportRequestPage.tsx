import { Badge, Card, EmptyState, PageHeader, Table, buttonStyle } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ApiError } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { Facts } from '../leads/Facts.js';
import { QueryState } from '../lib/QueryState.js';
import type { GrantView } from '../platform/platform-api.js';
import { GRANT_TONES, grantLength, supportRequestsKey, useSupportRequests } from './grants.js';

/** What support did with its access: every request, oldest first. */
function ActivityLog({ grant }: { readonly grant: GrantView }) {
  const { t, dateTime } = useI18n();
  const api = useApi();
  const activity = useQuery({
    queryKey: [...supportRequestsKey, grant.id, 'activity'],
    queryFn: ({ signal }) => api.supportRequests.activity(grant.id, signal),
    // While access runs, new requests keep arriving.
    refetchInterval: grant.status === 'active' ? 15_000 : false,
  });
  return (
    <Card title={t('supportAccess.detail.log')}>
      <p className="muted">{t('supportAccess.detail.logHint')}</p>
      <QueryState query={activity} error="supportAccess.detail.logError">
        {(entries) =>
          entries.length === 0 ? (
            <EmptyState title={t('supportAccess.detail.logEmpty')} />
          ) : (
            <Table label={t('supportAccess.detail.list')}>
              <thead>
                <tr>
                  <th scope="col">{t('supportAccess.detail.time')}</th>
                  <th scope="col">{t('supportAccess.detail.action')}</th>
                  <th scope="col">{t('supportAccess.detail.page')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, index) => (
                  <tr key={`${entry.at}-${String(index)}`}>
                    <td>{dateTime(entry.at)}</td>
                    <td>
                      {entry.method === 'GET'
                        ? t('supportAccess.detail.read')
                        : t('supportAccess.detail.write')}
                    </td>
                    <td>
                      <code>{entry.path}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryState>
    </Card>
  );
}

/**
 * /settings/support/:id — one support access request (the link in the
 * "support asks for access" notification) and what support looked at.
 */
export function SupportRequestPage() {
  const { t, plural, dateTime } = useI18n();
  const { id = '' } = useParams();
  const grant = useSupportRequests({
    select: (grants) => {
      const found = grants.find((item) => item.id === id);
      // There is no route for one request; a missing one reads like any 404.
      if (found === undefined) throw new ApiError(404, t('common.notFound'));
      return found;
    },
  });
  const when = (iso: string | null) => (iso === null ? null : dateTime(iso));
  return (
    <>
      <Link to="/settings/support" {...buttonStyle('ghost', 'sm')}>
        {t('supportAccess.detail.back')}
      </Link>
      <QueryState query={grant} error="supportAccess.error">
        {(found) => (
          <div className="stack">
            <PageHeader
              title={t('supportAccess.detail.title', { name: found.requestedBy })}
              description={found.reason}
            />
            <Card>
              <Facts
                facts={[
                  [
                    t('supportAccess.status'),
                    <Badge tone={GRANT_TONES[found.status]}>
                      {t(`supportAccess.statuses.${found.status}`)}
                    </Badge>,
                  ],
                  [t('supportAccess.length'), grantLength(plural, found.minutes)],
                  [t('supportAccess.requestedAt'), dateTime(found.requestedAt)],
                  [t('supportAccess.detail.approvedAt'), when(found.approvedAt)],
                  [t('supportAccess.detail.declinedAt'), when(found.declinedAt)],
                  [t('supportAccess.detail.expiresAt'), when(found.expiresAt)],
                  [t('supportAccess.detail.endedAt'), when(found.endedAt)],
                ]}
              />
            </Card>
            {found.approvedAt !== null && <ActivityLog grant={found} />}
          </div>
        )}
      </QueryState>
    </>
  );
}
