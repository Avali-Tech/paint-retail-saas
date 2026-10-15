import {
  canApproveSale,
  creditApprovalFor,
  type CreditApproval,
  type CreditApprovalLevel,
  type OrderCreditView,
  type SalesOrderView,
} from '@paint/shared';
import { Alert, Button, Card, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import { AskApprovalDialog, refreshApprovals } from '../credit/approval-parts.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';

/**
 * Whether the signed-in member may approve a sale at the store past this approval in
 * the same dialog (MVP 3 spec §4.3): a manager-level sale needs credit:approve_sale at
 * the store, an owner-level one the Owner role; a blocked party never.
 */
export function useCanOverride(storeId: string): (level: CreditApprovalLevel) => boolean {
  const profile = useCurrentProfile();
  const member = {
    permissions: new Set(profile.permissions),
    roleKey: profile.role.key,
    allStores: profile.allStores,
    storeIds: new Set(profile.storeIds),
  };
  return (level) => canApproveSale(level, member, storeId);
}

const APPROVAL_TEXT: Record<CreditApproval, MessageKey> = {
  none: 'orders.credit.withinLimit',
  manager: 'orders.credit.needsManager',
  owner: 'orders.credit.needsOwner',
  blocked: 'orders.credit.blocked',
};

/**
 * The order's credit approval (MVP 3 spec §4.3): waiting, or approved and ready to
 * confirm; otherwise "Ask for approval" for whoever may not approve it themselves.
 */
function OrderApproval({
  order,
  level,
}: {
  readonly order: SalesOrderView;
  readonly level: CreditApprovalLevel;
}) {
  const { t, label } = useI18n();
  const can = usePermissions();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const current = order.creditApproval;
  if (current !== null && current.status === 'pending') {
    return (
      <p className="notice">
        <Link to={`/credit/approvals/${current.id}`}>
          {t('approvals.waiting', {
            number: current.number,
            who: label('creditApprovalLevel', String(current.level)),
          })}
        </Link>
      </p>
    );
  }
  if (current !== null && current.status === 'approved') {
    return <p className="notice">{t('approvals.approvedReady', { number: current.number })}</p>;
  }
  if (!can('sales:manage')) return null;
  return (
    <div className="row">
      <Button
        variant="secondary"
        onClick={() => {
          setAsking(true);
        }}
      >
        {t('approvals.ask')}
      </Button>
      <AskApprovalDialog
        open={asking}
        onClose={() => {
          setAsking(false);
        }}
        title={t('approvals.askTitle')}
        description={t('approvals.askHint', { who: label('creditApprovalLevel', level) })}
        request={{ salesOrderId: order.id }}
        onAsked={async (asked) => {
          await refreshApprovals(queryClient);
          toast({ title: t('approvals.asked', { number: asked.number }), tone: 'success' });
        }}
      />
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
  const canOverride = useCanOverride(order.storeId);
  const { position, check, approval, site } = credit;
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
  if (site !== null) {
    rows.push([t('approvals.facts.site'), site.projectName]);
    rows.push([t('approvals.facts.siteLimit'), money(site.limitPaise)]);
    rows.push([t('approvals.facts.siteOwed'), money(site.exposurePaise)]);
    rows.push([
      t('approvals.facts.sitePercent'),
      t('orders.credit.percentValue', { percent: number(Number(site.check.utilizationPercent)) }),
    ]);
  }
  const level = approval === 'manager' || approval === 'owner' ? approval : null;
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
      {pending && level !== null && canOverride(level) && <p>{t('orders.credit.youMayApprove')}</p>}
      {pending && level !== null && !canOverride(level) && (
        <p>{t(level === 'owner' ? 'orders.credit.askOwner' : 'orders.credit.askManager')}</p>
      )}
      {pending && level !== null && <OrderApproval order={order} level={level} />}
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
