import type { CreditApprovalDetail } from '@paint/shared';
import { Badge, Button, Card, PageHeader, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useCurrentProfile } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import {
  APPROVAL_TONE,
  ApprovalDecision,
  ApprovalSubject,
  SaleCreditFacts,
  refreshApprovals,
} from './approval-parts.js';

function ApprovalDetail({ approval }: { readonly approval: CreditApprovalDetail }) {
  const api = useApi();
  const { t, label, money, dateTime, date } = useI18n();
  const profile = useCurrentProfile();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [cancelling, setCancelling] = useState(false);
  const open = approval.status === 'pending' || approval.status === 'approved';
  const mine = approval.requestedBy.memberId === profile.memberId;
  const facts: [string, React.ReactNode][] = [
    [t('approvals.what'), <ApprovalSubject key="subject" approval={approval} />],
    [
      t('approvals.level'),
      approval.level === null
        ? t('approvals.releaseLevel')
        : label('creditApprovalLevel', approval.level),
    ],
    [
      t('approvals.requestedBy'),
      t('approvals.byOn', { name: approval.requestedBy.name, when: dateTime(approval.createdAt) }),
    ],
    [t('approvals.why'), approval.reason],
  ];
  if (approval.kind === 'sale')
    facts.splice(1, 0, [t('approvals.amount'), money(approval.amountPaise)]);
  if (approval.store !== null) facts.push([t('approvals.store'), approval.store.name]);
  if (approval.site !== null) facts.push([t('approvals.facts.site'), approval.site.name]);
  // A decided approval always has who decided and when.
  if (approval.decidedAt !== null) {
    facts.push([
      t('approvals.decidedBy'),
      t('approvals.byOn', {
        name: String(approval.decidedBy?.name),
        when: dateTime(approval.decidedAt),
      }),
    ]);
    facts.push([t('approvals.decisionReason'), approval.decisionReason ?? t('common.none')]);
  }
  if (approval.waiveOverdueUntil !== null) {
    facts.push([t('approvals.waivedUntil'), date(approval.waiveOverdueUntil)]);
  }
  if (approval.usedAt !== null) facts.push([t('approvals.usedAt'), dateTime(approval.usedAt)]);

  const cancel = async () => {
    setCancelling(true);
    try {
      await api.credit.cancelApproval(approval.id);
      await refreshApprovals(queryClient);
      toast({ title: t('approvals.cancelled'), tone: 'success' });
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' });
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('approvals.detailTitle', { number: approval.number })}
        description={<Link to={`/parties/${approval.party.id}`}>{approval.party.name}</Link>}
        actions={
          <div className="row">
            {approval.canDecide && <ApprovalDecision approval={approval} />}
            {open && (mine || approval.canDecide) && (
              <Button
                size="sm"
                variant="secondary"
                loading={cancelling}
                onClick={() => {
                  void cancel();
                }}
              >
                {t('approvals.cancel')}
              </Button>
            )}
          </div>
        }
      />
      <Card
        title={t('approvals.details')}
        actions={
          <Badge tone={APPROVAL_TONE[approval.status]}>
            {label('creditApprovalStatus', approval.status)}
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
      {approval.checkAtRequest !== null && (
        <Card title={t('approvals.atRequest')}>
          <SaleCreditFacts credit={approval.checkAtRequest} label={t('approvals.atRequest')} />
        </Card>
      )}
      {approval.checkNow !== null && (
        <Card title={t('approvals.now')}>
          <SaleCreditFacts credit={approval.checkNow} label={t('approvals.now')} />
        </Card>
      )}
    </>
  );
}

/** /credit/approvals/:id — one approval, where its notifications lead. */
export function CreditApprovalPage() {
  const api = useApi();
  // The route always has an :id.
  const id = String(useParams().id);
  const approval = useQuery({
    queryKey: ['credit-approvals', 'one', id],
    queryFn: ({ signal }) => api.credit.approval(id, signal),
  });
  return (
    <QueryState query={approval} error="approvals.oneError">
      {(data) => <ApprovalDetail approval={data} />}
    </QueryState>
  );
}
