import {
  canOverrideCredit,
  creditApprovalFor,
  type CreditApproval,
  type CreditCheck,
  type OrderCreditView,
  type SalesOrderView,
} from '@paint/shared';
import { Alert, Button, Card, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { usePartyOverview } from '../pos/CustomerPanel.js';

/** Whether the signed-in member may confirm past this approval in the same dialog. */
export function useCanOverride(): (approval: CreditApproval) => boolean {
  const profile = useCurrentProfile();
  const permissions = new Set(profile.permissions);
  return (approval) => canOverrideCredit(approval, { permissions, roleKey: profile.role.key });
}

const APPROVAL_TEXT: Record<CreditApproval, MessageKey> = {
  none: 'orders.credit.withinLimit',
  manager: 'orders.credit.needsManager',
  owner: 'orders.credit.needsOwner',
  blocked: 'orders.credit.blocked',
};

/**
 * "Request owner approval": a credit request for a limit that covers the order, so the
 * owner sees it in Credit requests and can raise the limit (or confirm the order).
 */
function ApprovalRequest({
  order,
  check,
}: {
  readonly order: SalesOrderView;
  readonly check: CreditCheck;
}) {
  const api = useApi();
  const { t, money } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const overview = usePartyOverview(order.billTo.id);
  const [sending, setSending] = useState(false);
  const credit = overview.data?.credit ?? null;
  if (credit === null) return null;
  if (credit.pendingRequest !== null) {
    return (
      <p>
        <Link to={`/credit-requests/${credit.pendingRequest.id}`}>
          {t('orders.credit.requestWaiting', { number: credit.pendingRequest.number })}
        </Link>
      </p>
    );
  }
  // Whole rupees, rounded up so the order fits.
  const limitPaise = Math.ceil(check.projectedExposurePaise / 100) * 100;
  const request = async () => {
    setSending(true);
    try {
      await api.credit.request({
        partyId: order.billTo.id,
        limitPaise,
        creditDays: credit.creditDays,
        note: t('orders.credit.requestNote', { number: order.number }),
      });
      await queryClient.invalidateQueries({ queryKey: ['party', order.billTo.id] });
      toast({ title: t('orders.credit.requested'), tone: 'success' });
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' });
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="row">
      <Button
        variant="secondary"
        loading={sending}
        onClick={() => {
          void request();
        }}
      >
        {t('orders.credit.request', { amount: money(limitPaise) })}
      </Button>
    </div>
  );
}

/** The figures (spec §4.4 / §7 Round 4 demo): limit, owed, this order, and % of the limit. */
function CreditFigures({
  order,
  credit,
}: {
  readonly order: SalesOrderView;
  readonly credit: OrderCreditView;
}) {
  const { t, money, number, label } = useI18n();
  const can = usePermissions();
  const canOverride = useCanOverride();
  const { position, check, approval } = credit;
  const percent = check?.utilizationPercent ?? null;
  const rows: [string, string][] = [
    [t('orders.credit.status'), label('creditStatus', position.status)],
    [t('orders.credit.limit'), money(position.limitPaise)],
    [t('orders.credit.owed'), money(position.exposurePaise)],
    [t('orders.credit.order'), money(order.totalPaise)],
    [
      t('orders.credit.percent'),
      percent === null
        ? t('common.none')
        : t('orders.credit.percentValue', { percent: number(percent) }),
    ],
  ];
  if (position.overdueDays > 0) {
    rows.push([t('orders.credit.overdue'), number(position.overdueDays)]);
  }
  const over = approval === 'manager' || approval === 'owner';
  const pending = order.status === 'draft';
  return (
    <div className="stack">
      <dl className="facts" aria-label={t('orders.credit.title')}>
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {credit.exposureSource === 'manual' && (
        <p className="muted">{t('orders.credit.manualSource')}</p>
      )}
      <Alert tone={approval === 'none' ? 'success' : approval === 'blocked' ? 'danger' : 'warning'}>
        {approval === 'blocked' && check?.blockedBecause != null
          ? t('orders.credit.blockedBecause', {
              reason: label('creditBlock', check.blockedBecause),
            })
          : t(APPROVAL_TEXT[approval])}
      </Alert>
      {pending && over && canOverride(approval) && <p>{t('orders.credit.youMayApprove')}</p>}
      {pending && over && !canOverride(approval) && (
        <>
          <p>{t(approval === 'owner' ? 'orders.credit.askOwner' : 'orders.credit.askManager')}</p>
          {approval === 'owner' && check !== null && can('credit:manage') && (
            <ApprovalRequest order={order} check={check} />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The credit panel of a postpaid order: before confirming, the live check the
 * confirm will run; afterwards, the check as it stood and any override.
 */
export function OrderCreditPanel({ order }: { readonly order: SalesOrderView }) {
  const api = useApi();
  const { t, label, dateTime } = useI18n();
  const live = useQuery({
    queryKey: ['sales-orders', order.id, 'credit-check'],
    queryFn: ({ signal }) => api.orders.creditCheck(order.id, signal),
    enabled: order.status === 'draft',
  });
  if (order.paymentTerms !== 'postpaid') return null;
  if (order.status !== 'draft') {
    const check = order.creditCheck;
    const override = order.creditOverride;
    return (
      <Card title={t('orders.credit.title')}>
        <div className="stack">
          {check === null ? (
            <p>{t('orders.credit.notChecked')}</p>
          ) : (
            <p>
              {t('orders.credit.atConfirm', {
                decision: label('creditApprovals', creditApprovalFor(check.decision)),
                percent: check.utilizationPercent ?? 0,
              })}
            </p>
          )}
          {override !== null && (
            <Alert tone="info">
              {t('orders.credit.overridden', {
                approval: label('creditApprovals', override.approval),
                name: override.memberName,
                reason: override.reason,
                at: dateTime(override.at),
              })}
            </Alert>
          )}
        </div>
      </Card>
    );
  }
  return (
    <Card title={t('orders.credit.title')}>
      <QueryState query={live} error="orders.credit.error">
        {(credit) => <CreditFigures order={order} credit={credit} />}
      </QueryState>
    </Card>
  );
}
