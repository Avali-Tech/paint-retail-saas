import { Badge, Card, PageHeader } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { CreditRequest } from '../api/credit.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { REQUEST_TONE } from './CreditRequestsPage.js';
import { RequestDecision } from './RequestDecision.js';

function RequestDetail({ request }: { readonly request: CreditRequest }) {
  const { t, plural, label, money, dateTime } = useI18n();
  const can = usePermissions();
  const terms = (limitPaise: number, creditDays: number) =>
    t('credit.terms', {
      limit: money(limitPaise),
      days: plural('credit.daysValue', creditDays),
    });
  const facts: [string, string][] = [
    [t('credit.requests.asked'), terms(request.limitPaise, request.creditDays)],
    [t('credit.requests.previous'), terms(request.previousLimitPaise, request.previousCreditDays)],
    [
      t('credit.requests.requestedBy'),
      t('credit.requests.byOn', {
        name: request.requestedBy.name,
        when: dateTime(request.createdAt),
      }),
    ],
    [t('credit.requests.why'), request.note ?? t('common.none')],
  ];
  // A decided request always has who decided and when.
  if (request.decidedAt !== null) {
    facts.push([
      t('credit.requests.decidedBy'),
      t('credit.requests.byOn', {
        name: String(request.decidedBy?.name),
        when: dateTime(request.decidedAt),
      }),
    ]);
    facts.push([t('credit.requests.decisionNote'), request.decisionNote ?? t('common.none')]);
  }
  return (
    <>
      <PageHeader
        title={t('credit.requests.detailTitle', { number: request.number })}
        description={<Link to={`/parties/${request.party.id}`}>{request.party.name}</Link>}
        actions={
          can('credit:approve') && request.status === 'pending' ? (
            <div className="row">
              <RequestDecision request={request} />
            </div>
          ) : undefined
        }
      />
      <Card
        title={t('credit.requests.details')}
        actions={
          <Badge tone={REQUEST_TONE[request.status]}>
            {label('creditRequestStatus', request.status)}
          </Badge>
        }
      >
        <dl className="facts">
          {facts.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </>
  );
}

/** /credit-requests/:id — one request, where its notifications lead. */
export function CreditRequestPage() {
  const api = useApi();
  // The route always has an :id.
  const id = String(useParams().id);
  const request = useQuery({
    queryKey: ['credit-requests', 'one', id],
    queryFn: ({ signal }) => api.credit.getRequest(id, signal),
  });
  return (
    <QueryState query={request} error="credit.requests.oneError">
      {(data) => <RequestDetail request={data} />}
    </QueryState>
  );
}
