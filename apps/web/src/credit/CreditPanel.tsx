import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  Textarea,
  useToast,
  type Tone,
} from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { CREDIT_RISKS, type CreditRisk, type CreditSummary } from '../api/credit.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { parseRupees, rupeesInput } from '../lib/inputs.js';
import { RequestDecision, refreshCredit } from './RequestDecision.js';
import { RequestFields } from './RequestFields.js';

export const STATUS_TONE: Record<CreditSummary['status'], Tone> = {
  none: 'neutral',
  active: 'success',
  on_hold: 'danger',
};

const DECISION_TONE: Record<CreditSummary['check']['decision'], Tone> = {
  allowed: 'success',
  manager_approval: 'warning',
  owner_approval: 'warning',
  blocked: 'danger',
};

/** Up to ₹10 crore, as the API allows. */
export const MAX_LIMIT_PAISE = 10_000_000_000;

/** A credit request typed in the dialog: the limit in rupees and the days, checked. */
export function readRequest(
  limit: string,
  days: string,
): { limitPaise: number; creditDays: number } | 'limit' | 'days' {
  const limitPaise = parseRupees(limit);
  if (limitPaise === null || limitPaise <= 0 || limitPaise > MAX_LIMIT_PAISE) return 'limit';
  if (!/^\d{1,3}$/.test(days.trim()) || Number(days) > 365) return 'days';
  return { limitPaise, creditDays: Number(days) };
}

/** The most a party can be recorded as owing, as the API allows (₹1,000 crore). */
export const MAX_EXPOSURE_PAISE = 100_000_000_000_00;

/** What the party owes (rupees) and how many days late, typed in the dialog, checked. */
export function readBalance(
  owed: string,
  overdue: string,
): { manualExposurePaise: number; overdueDays: number } | 'owed' | 'overdue' {
  const manualExposurePaise = parseRupees(owed);
  if (manualExposurePaise === null || manualExposurePaise < 0) return 'owed';
  if (manualExposurePaise > MAX_EXPOSURE_PAISE) return 'owed';
  if (!/^\d{1,5}$/.test(overdue.trim()) || Number(overdue) > 10_000) return 'overdue';
  return { manualExposurePaise, overdueDays: Number(overdue) };
}

/**
 * A party's credit on its 360 page: limit, days, what it owes, what the next
 * sale on credit needs, and the actions the member's role allows. Requesting,
 * holding and updating what the party owes need credit:manage; approving, rejecting and releasing need credit:approve.
 */
export function CreditPanel({
  partyId,
  credit,
}: {
  readonly partyId: string;
  readonly credit: CreditSummary;
}) {
  const api = useApi();
  const { t, label, money, number } = useI18n();
  const can = usePermissions();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'request' | 'hold' | 'balance' | null>(null);
  const [limit, setLimit] = useState('');
  const [days, setDays] = useState('');
  const [risk, setRisk] = useState<CreditRisk>(credit.risk);
  const [text, setText] = useState('');
  const [releasing, setReleasing] = useState(false);
  const { check, pendingRequest } = credit;

  const open = (next: 'request' | 'hold' | 'balance') => {
    // The balance dialog reuses the two amount fields for what is owed and how late.
    if (next === 'balance') {
      setLimit(rupeesInput(credit.manualExposurePaise));
      setDays(String(credit.overdueDays));
    } else {
      setLimit(rupeesInput(credit.limitPaise === 0 ? null : credit.limitPaise));
      setDays(String(credit.creditDays));
    }
    setRisk(credit.risk);
    setText('');
    setDialog(next);
  };
  const close = () => {
    setDialog(null);
  };
  const done = async (message: string) => {
    await refreshCredit(queryClient);
    toast({ title: message, tone: 'success' });
  };
  const release = async () => {
    setReleasing(true);
    try {
      await api.credit.release(partyId);
      await done(t('credit.released'));
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' });
    } finally {
      setReleasing(false);
    }
  };

  const decision =
    check.blockedBecause === null
      ? label('creditDecision', check.decision)
      : `${label('creditDecision', check.decision)}: ${label('creditBlock', check.blockedBecause)}`;
  const manage = can('credit:manage');
  const approve = can('credit:approve');

  return (
    <Card
      title={t('credit.title')}
      actions={
        <Badge tone={STATUS_TONE[credit.status]}>{label('creditStatus', credit.status)}</Badge>
      }
    >
      <div className="stack">
        <dl className="facts">
          <div>
            <dt>{t('credit.limit')}</dt>
            <dd>{money(credit.limitPaise)}</dd>
          </div>
          <div>
            <dt>{t('credit.days')}</dt>
            <dd>{t('credit.daysValue', { days: credit.creditDays })}</dd>
          </div>
          <div>
            <dt>{t('credit.exposure')}</dt>
            <dd>{money(credit.manualExposurePaise)}</dd>
          </div>
          <div>
            <dt>{t('credit.available')}</dt>
            <dd>{money(check.availablePaise)}</dd>
          </div>
          <div>
            <dt>{t('credit.utilization')}</dt>
            <dd>
              {check.utilizationPercent === null
                ? t('common.none')
                : t('credit.percent', { value: number(check.utilizationPercent) })}
            </dd>
          </div>
          <div>
            <dt>{t('credit.overdue')}</dt>
            <dd>{t('credit.daysValue', { days: credit.overdueDays })}</dd>
          </div>
          <div>
            <dt>{t('credit.risk')}</dt>
            <dd>{label('creditRisk', credit.risk)}</dd>
          </div>
          <div>
            <dt>{t('credit.decision')}</dt>
            <dd>
              <Badge tone={DECISION_TONE[check.decision]}>{decision}</Badge>
            </dd>
          </div>
        </dl>
        {pendingRequest !== null && (
          <p className="notice">
            <Link to={`/credit-requests/${pendingRequest.id}`}>
              {t('credit.pending', {
                number: pendingRequest.number,
                limit: money(pendingRequest.limitPaise),
                days: pendingRequest.creditDays,
              })}
            </Link>
          </p>
        )}
        <div className="row">
          {manage && pendingRequest === null && (
            <Button
              variant="secondary"
              onClick={() => {
                open('request');
              }}
            >
              {t('credit.request')}
            </Button>
          )}
          {manage && credit.status === 'active' && (
            <Button
              variant="secondary"
              onClick={() => {
                open('hold');
              }}
            >
              {t('credit.hold')}
            </Button>
          )}
          {manage && (
            <Button
              variant="secondary"
              onClick={() => {
                open('balance');
              }}
            >
              {t('credit.balance')}
            </Button>
          )}
          {approve && credit.status === 'on_hold' && (
            <Button
              variant="secondary"
              loading={releasing}
              onClick={() => {
                void release();
              }}
            >
              {t('credit.release')}
            </Button>
          )}
          {approve && pendingRequest !== null && <RequestDecision request={pendingRequest} />}
        </div>
      </div>

      <FormDialog
        open={dialog === 'request'}
        onClose={close}
        title={t('credit.requestTitle')}
        description={t('credit.requestHint')}
        submitLabel={t('credit.submit')}
        onSubmit={async () => {
          const read = readRequest(limit, days);
          if (read === 'limit') return t('credit.limitInvalid');
          if (read === 'days') return t('credit.daysInvalid');
          const note = text.trim();
          await api.credit.request({ partyId, ...read, ...(note === '' ? {} : { note }) });
          await done(t('credit.requested'));
          return undefined;
        }}
      >
        <RequestFields
          values={{ limit, days, note: text }}
          onChange={(values) => {
            setLimit(values.limit);
            setDays(values.days);
            setText(values.note);
          }}
        />
      </FormDialog>

      <FormDialog
        open={dialog === 'balance'}
        onClose={close}
        title={t('credit.balanceTitle')}
        description={t('credit.balanceHint')}
        submitLabel={t('common.save')}
        onSubmit={async () => {
          const read = readBalance(limit, days);
          if (read === 'owed') return t('credit.owedInvalid');
          if (read === 'overdue') return t('credit.overdueInvalid');
          await api.credit.update(partyId, { risk, ...read });
          await done(t('credit.balanceSaved'));
          return undefined;
        }}
      >
        <Field label={t('credit.owedLabel')}>
          <Input
            inputMode="decimal"
            value={limit}
            onChange={(event) => {
              setLimit(event.target.value);
            }}
          />
        </Field>
        <Field label={t('credit.overdueLabel')}>
          <Input
            inputMode="numeric"
            value={days}
            onChange={(event) => {
              setDays(event.target.value);
            }}
          />
        </Field>
        <Field label={t('credit.risk')}>
          <Select
            value={risk}
            onChange={(event) => {
              setRisk(event.target.value as CreditRisk);
            }}
          >
            {CREDIT_RISKS.map((value) => (
              <option key={value} value={value}>
                {label('creditRisk', value)}
              </option>
            ))}
          </Select>
        </Field>
      </FormDialog>

      <FormDialog
        open={dialog === 'hold'}
        onClose={close}
        title={t('credit.holdTitle')}
        submitLabel={t('credit.hold')}
        onSubmit={async () => {
          const reason = text.trim();
          if (reason.length < 3) return t('credit.reasonInvalid');
          await api.credit.hold(partyId, reason);
          await done(t('credit.held'));
          return undefined;
        }}
      >
        <Field label={t('credit.reason')}>
          <Textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        </Field>
      </FormDialog>
    </Card>
  );
}
