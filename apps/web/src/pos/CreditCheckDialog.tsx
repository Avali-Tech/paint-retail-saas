import {
  approvalLevelOf,
  canApproveSale,
  type CreditApprovalRefusal,
  type CreditApprovalSummary,
  type CreditApprovalView,
  type CreditCheck,
} from '@paint/shared';
import { Field, Textarea } from '@paint/ui';
import { useState } from 'react';
import { useApi } from '../app/services.js';
import { useCurrentProfile } from '../auth/session.js';
import { REASON_MIN, SaleCreditFacts } from '../credit/approval-parts.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { ApiError } from '../api/errors.js';

const CREDIT_CODES: readonly string[] = [
  'credit_approval_required',
  'credit_approval_pending',
  'credit_approval_stale',
  'credit_blocked',
  'credit_override_not_allowed',
];

/** The credit refusal an issue answered with, or null for any other error. */
export function creditRefusalOf(error: unknown): CreditApprovalRefusal | null {
  if (!(error instanceof ApiError) || !CREDIT_CODES.includes(String(error.body.code))) return null;
  return error.body as unknown as CreditApprovalRefusal;
}

/** What the counter can do about a refused bill on credit. */
export type CreditStep = 'approve' | 'ask' | 'pending' | 'blocked';

export function creditStep(refusal: CreditApprovalRefusal, mayApprove: boolean): CreditStep {
  if (refusal.code === 'credit_blocked') return 'blocked';
  if (refusal.code === 'credit_approval_pending') return 'pending';
  return mayApprove ? 'approve' : 'ask';
}

/**
 * The approval prompt at the counter (MVP 3 spec §5.3): when issuing on credit is
 * refused, the figures and what it takes. An approver gives a reason and issues;
 * anyone else asks for approval and the bill is held until it is decided; a bill
 * already waiting is held again; a blocked customer pays instead.
 */
export function CreditCheckDialog({
  refusal,
  draftId,
  storeId,
  onClose,
  onApprove,
  onHold,
  onPay,
}: {
  readonly refusal: CreditApprovalRefusal;
  readonly draftId: string;
  readonly storeId: string;
  readonly onClose: () => void;
  /** Issues again with the member's own approval. */
  readonly onApprove: (reason: string) => Promise<void>;
  /** Keeps the bill as held and starts the next one. */
  readonly onHold: (asked: CreditApprovalView | null) => Promise<void>;
  /** Back to taking the money. */
  readonly onPay: () => void;
}) {
  const api = useApi();
  const { t, label } = useI18n();
  const profile = useCurrentProfile();
  const [reason, setReason] = useState('');
  const { credit, approval } = refusal;
  const level = approvalLevelOf(credit.approval);
  const member = {
    permissions: new Set(profile.permissions),
    roleKey: profile.role.key,
    allStores: profile.allStores,
    storeIds: new Set(profile.storeIds),
  };
  const step = creditStep(refusal, level !== null && canApproveSale(level, member, storeId));
  // Past the rules (approve, ask, pending) the check names a level; blocked, a reason.
  const who = label('creditApprovalLevel', String(level));
  const description = () => {
    if (step === 'approve') return t('approvals.pos.approveHint', { who });
    if (step === 'ask') return t('approvals.pos.askHint', { who });
    if (step === 'pending') {
      // A refusal for a waiting approval always names it.
      const [waiting] = [approval] as [CreditApprovalSummary];
      return t('approvals.waiting', { number: waiting.number, who });
    }
    // Blocked by the customer's own credit, or by the site's.
    const blocked = [credit.check, credit.site?.check].find(
      (check) => check?.decision === 'blocked',
    );
    return t('orders.credit.blockedBecause', {
      reason: label('creditBlock', String(blocked?.blockedBecause)),
    });
  };
  const submit = {
    approve: t('approvals.pos.approveIssue'),
    ask: t('approvals.ask'),
    pending: t('approvals.pos.hold'),
    blocked: t('approvals.pos.pay'),
  } as const;
  const needsReason = step === 'approve' || step === 'ask';
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('approvals.pos.title')}
      description={description()}
      submitLabel={submit[step]}
      onSubmit={async () => {
        const text = reason.trim();
        if (needsReason && text.length < REASON_MIN) return t('approvals.reasonInvalid');
        if (step === 'approve') {
          await onApprove(text);
        } else if (step === 'ask') {
          // A refused bill on credit always has its check.
          const [check] = [credit.check] as [CreditCheck];
          const asked = await api.credit.askApproval({
            invoiceId: draftId,
            amountPaise: check.projectedExposurePaise - credit.position.exposurePaise,
            reason: text,
          });
          await onHold(asked);
        } else if (step === 'pending') {
          await onHold(null);
        } else {
          onPay();
        }
        return undefined;
      }}
    >
      <SaleCreditFacts credit={credit} label={t('approvals.pos.title')} />
      {needsReason && (
        <Field label={t(step === 'approve' ? 'approvals.reason' : 'approvals.askReason')} required>
          <Textarea
            maxLength={1000}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </Field>
      )}
    </FormDialog>
  );
}
