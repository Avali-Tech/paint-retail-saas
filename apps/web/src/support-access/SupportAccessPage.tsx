import { Badge, Button, Card, PageHeader, Table, useToast } from '@paint/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import type { GrantView } from '../platform/platform-api.js';
import {
  GRANT_TONES,
  grantLength,
  openGrants,
  supportRequestsKey,
  useSupportRequests,
} from './grants.js';

type Decision = 'approve' | 'decline' | 'end';

/** Approve, decline or end one grant, then reload the lists and the banner. */
function useDecision() {
  const api = useApi();
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ decision, id }: { decision: Decision; id: string }) =>
      api.supportRequests[decision](id),
    onSuccess: async (grant, { decision }) => {
      const messages = {
        approve: () => t('supportAccess.approved', { time: dateTime(String(grant.expiresAt)) }),
        decline: () => t('supportAccess.declined'),
        end: () => t('supportAccess.ended'),
      };
      toast({ title: messages[decision](), tone: 'success' });
      await queryClient.invalidateQueries({ queryKey: supportRequestsKey });
    },
    onError: (error) => {
      toast({ title: errorMessage(error), tone: 'danger' });
    },
  });
}

function GrantSummary({ grant }: { readonly grant: GrantView }) {
  const { t, plural, dateTime } = useI18n();
  return (
    <>
      <strong>
        {t('supportAccess.asks', {
          name: grant.requestedBy,
          length: grantLength(plural, grant.minutes),
        })}
      </strong>
      <span>{grant.reason}</span>
      <span className="cell-meta">
        {t('supportAccess.askedAt', { time: dateTime(grant.requestedAt) })}
      </span>
    </>
  );
}

/**
 * /settings/support — owners and admins (organization:manage) decide on the
 * platform's requests for access, end running access and look back at earlier
 * requests with what support looked at.
 */
export function SupportAccessPage() {
  const { t, plural, dateTime } = useI18n();
  const grants = useSupportRequests();
  const decide = useDecision();

  return (
    <>
      <PageHeader title={t('supportAccess.title')} description={t('supportAccess.description')} />
      <QueryState query={grants} error="supportAccess.error">
        {(all) => {
          const { pending, active, closed } = openGrants(all);
          return (
            <div className="stack">
              <Card title={t('supportAccess.pendingTitle')}>
                {pending.length === 0 ? (
                  <p className="muted">{t('supportAccess.pendingEmpty')}</p>
                ) : (
                  <ul className="record-list">
                    {pending.map((grant) => (
                      <li key={grant.id}>
                        <GrantSummary grant={grant} />
                        <div className="row">
                          <Button
                            size="sm"
                            disabled={decide.isPending}
                            onClick={() => {
                              decide.mutate({ decision: 'approve', id: grant.id });
                            }}
                          >
                            {t('supportAccess.approve')}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={decide.isPending}
                            onClick={() => {
                              decide.mutate({ decision: 'decline', id: grant.id });
                            }}
                          >
                            {t('supportAccess.decline')}
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title={t('supportAccess.activeTitle')}>
                {active.length === 0 ? (
                  <p className="muted">{t('supportAccess.activeEmpty')}</p>
                ) : (
                  <ul className="record-list">
                    {active.map((grant) => (
                      <li key={grant.id}>
                        <GrantSummary grant={grant} />
                        <Badge tone="success">
                          {t('supportAccess.until', { time: dateTime(String(grant.expiresAt)) })}
                        </Badge>
                        <div className="row">
                          <Link to={`/settings/support/${grant.id}`}>
                            {t('supportAccess.activity')}
                          </Link>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={decide.isPending}
                            onClick={() => {
                              decide.mutate({ decision: 'end', id: grant.id });
                            }}
                          >
                            {t('supportAccess.end')}
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title={t('supportAccess.historyTitle')}>
                {closed.length === 0 ? (
                  <p className="muted">{t('supportAccess.historyEmpty')}</p>
                ) : (
                  <Table label={t('supportAccess.list')}>
                    <thead>
                      <tr>
                        <th scope="col">{t('supportAccess.requestedBy')}</th>
                        <th scope="col">{t('supportAccess.reason')}</th>
                        <th scope="col">{t('supportAccess.length')}</th>
                        <th scope="col">{t('supportAccess.status')}</th>
                        <th scope="col">{t('supportAccess.requestedAt')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {closed.map((grant) => (
                        <tr key={grant.id}>
                          <th scope="row">
                            <Link to={`/settings/support/${grant.id}`}>{grant.requestedBy}</Link>
                          </th>
                          <td>{grant.reason}</td>
                          <td>{grantLength(plural, grant.minutes)}</td>
                          <td>
                            <Badge tone={GRANT_TONES[grant.status]}>
                              {t(`supportAccess.statuses.${grant.status}`)}
                            </Badge>
                          </td>
                          <td>{dateTime(grant.requestedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
            </div>
          );
        }}
      </QueryState>
    </>
  );
}
