import {
  MAX_OVERDUE_WAIVER_DAYS,
  type CreateCreditApprovalRequest,
  type CreditApprovalStatus,
  type CreditApprovalView,
  type SaleCreditView,
} from '@paint/shared';
import { Button, Field, Input, Textarea, useToast, type Tone } from '@paint/ui';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';

/** A reason as the API takes it: 3 characters at least. */
export const REASON_MIN = 3;

export const APPROVAL_TONE: Record<CreditApprovalStatus, Tone> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
  used: 'info',
};

/** After any approval changes: the queues, the orders and the customer 360s load again. */
export async function refreshApprovals(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['credit-approvals'] }),
    queryClient.invalidateQueries({ queryKey: ['sales-orders'] }),
    queryClient.invalidateQueries({ queryKey: ['party'] }),
  ]);
}

/** What an approval is for: the hold's release, an order, or a bill (with links). */
export function ApprovalSubject({ approval }: { readonly approval: CreditApprovalView }) {
  const { t } = useI18n();
  const { subject } = approval;
  if (subject === null) return <>{t('approvals.release')}</>;
  if (subject.type === 'sales_order') {
    return (
      <Link to={`/sales-orders/${subject.id}`}>
        {t('approvals.order', { number: String(subject.number) })}
      </Link>
    );
  }
  return (
    <Link to={`/invoices/${subject.id}`}>
      {subject.number === null
        ? t('approvals.draftBill')
        : t('approvals.bill', { number: subject.number })}
    </Link>
  );
}

/**
 * Where a customer (and its site) stands for a sale on credit: the limit, what it
 * owes, the sale, and the share of the limit it comes to.
 */
export function SaleCreditFacts({
  credit,
  label: name,
}: {
  readonly credit: SaleCreditView;
  readonly label: string;
}) {
  const { t, money, number, label } = useI18n();
  const { position, check, site } = credit;
  const percent = (value: number | null) =>
    value === null ? t('common.none') : t('credit.percent', { value: number(value) });
  const rows: [string, ReactNode][] = [
    [t('orders.credit.status'), label('creditStatus', position.status)],
    [t('orders.credit.limit'), money(position.limitPaise)],
    [t('orders.credit.owed'), money(position.exposurePaise)],
  ];
  if (check !== null) {
    rows.push([
      t('approvals.facts.sale'),
      money(check.projectedExposurePaise - position.exposurePaise),
    ]);
    rows.push([t('approvals.facts.projected'), money(check.projectedExposurePaise)]);
    rows.push([t('orders.credit.percent'), percent(check.utilizationPercent)]);
  }
  if (position.overdueDays > 0) {
    rows.push([t('orders.credit.overdue'), number(position.overdueDays)]);
  }
  if (site !== null) {
    rows.push([t('approvals.facts.site'), site.projectName]);
    rows.push([t('approvals.facts.siteLimit'), money(site.limitPaise)]);
    rows.push([t('approvals.facts.siteOwed'), money(site.exposurePaise)]);
    rows.push([t('approvals.facts.sitePercent'), percent(site.check.utilizationPercent)]);
  }
  return (
    <dl className="facts" aria-label={name}>
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "Ask for approval": the reason, then the request to the approvers. */
export function AskApprovalDialog({
  open,
  onClose,
  title,
  description,
  request,
  onAsked,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description: string;
  /** Everything but the reason. */
  readonly request: DistributiveOmit<CreateCreditApprovalRequest, 'reason'>;
  readonly onAsked: (approval: CreditApprovalView) => Promise<void> | void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      submitLabel={t('approvals.send')}
      onSubmit={async () => {
        const text = reason.trim();
        if (text.length < REASON_MIN) return t('approvals.reasonInvalid');
        const approval = await api.credit.askApproval({ ...request, reason: text });
        setReason('');
        await onAsked(approval);
        return undefined;
      }}
    >
      <Field label={t('approvals.askReason')} required>
        <Textarea
          maxLength={1000}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Approve and Reject for an approval the member may decide, each with its dialog: a
 * reason (needed to reject), and for a release the date the overdue days are waived to.
 */
export function ApprovalDecision({ approval }: { readonly approval: CreditApprovalView }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [waive, setWaive] = useState('');
  const rejecting = mode === 'reject';
  const release = approval.kind === 'release';
  const open = (next: 'approve' | 'reject') => {
    setReason('');
    setWaive('');
    setMode(next);
  };
  return (
    <>
      <Button
        size="sm"
        aria-label={t('approvals.approveNumber', { number: approval.number })}
        onClick={() => {
          open('approve');
        }}
      >
        {t('approvals.approve')}
      </Button>
      <Button
        size="sm"
        variant="danger"
        aria-label={t('approvals.rejectNumber', { number: approval.number })}
        onClick={() => {
          open('reject');
        }}
      >
        {t('approvals.reject')}
      </Button>
      <FormDialog
        open={mode !== null}
        onClose={() => {
          setMode(null);
        }}
        title={t(rejecting ? 'approvals.rejectTitle' : 'approvals.approveTitle', {
          number: approval.number,
        })}
        submitLabel={t(rejecting ? 'approvals.reject' : 'approvals.approve')}
        onSubmit={async () => {
          const text = reason.trim();
          if (rejecting) {
            if (text.length < REASON_MIN) return t('approvals.reasonInvalid');
            await api.credit.rejectApproval(approval.id, text);
          } else {
            await api.credit.approveApproval(approval.id, {
              ...(text === '' ? {} : { reason: text }),
              ...(release && waive !== '' ? { waiveOverdueUntil: waive } : {}),
            });
          }
          await refreshApprovals(queryClient);
          toast({
            title: t(rejecting ? 'approvals.rejected' : 'approvals.approved'),
            tone: 'success',
          });
          return undefined;
        }}
      >
        <Field label={t(rejecting ? 'approvals.reason' : 'approvals.reasonOptional')}>
          <Textarea
            maxLength={1000}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </Field>
        {release && !rejecting && <WaiverField value={waive} onChange={setWaive} />}
      </FormDialog>
    </>
  );
}

/** The date overdue days stop blocking credit until, when a hold is released. */
export function WaiverField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Field
      label={t('approvals.waiveLabel')}
      hint={t('approvals.waiveHint', { days: MAX_OVERDUE_WAIVER_DAYS })}
    >
      <Input
        type="date"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </Field>
  );
}
