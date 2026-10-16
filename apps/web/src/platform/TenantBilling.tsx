import {
  PLANS,
  SUBSCRIPTION_PAYMENT_MODES,
  type SubscriptionInvoiceView,
  type SubscriptionPaymentMode,
  type TenantBillingView,
} from '@paint/shared';
import { Alert, Button, Card, EmptyState, Field, Input, Select, Table, useToast } from '@paint/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/errors.js';
import { InvoiceStatus } from '../billing/invoice-parts.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { parseRupees, rupeesInput } from '../lib/inputs.js';
import { QueryState } from '../lib/QueryState.js';
import type { TenantDetail } from './platform-api.js';
import { PLATFORM_QUERY, usePlatformApi } from './session.js';

const billingKey = (id: string) => [PLATFORM_QUERY, 'tenant', id, 'billing'];

/** Today in India as YYYY-MM-DD (the console's default payment date). */
function indiaToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
}

function RecordPaymentDialog({
  tenant,
  invoice,
  onClose,
  onSaved,
}: {
  readonly tenant: TenantDetail;
  readonly invoice: SubscriptionInvoiceView;
  readonly onClose: () => void;
  readonly onSaved: (saved: TenantBillingView) => Promise<void>;
}) {
  const { t, money } = useI18n();
  const api = usePlatformApi();
  const toast = useToast();
  const [amount, setAmount] = useState(rupeesInput(invoice.totalPaise));
  const [paidOn, setPaidOn] = useState(() => indiaToday(new Date()));
  const [mode, setMode] = useState<SubscriptionPaymentMode>('bank_transfer');
  const [reference, setReference] = useState('');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('platform.billing.recordTitle', { number: invoice.number })}
      description={t('platform.billing.recordHint')}
      submitLabel={t('platform.billing.record')}
      onSubmit={async () => {
        const paise = parseRupees(amount);
        if (paise === null || paise < 1 || paise > invoice.totalPaise) {
          return t('platform.billing.amountInvalid', { total: money(invoice.totalPaise) });
        }
        if (reference.trim() === '') return t('platform.billing.referenceInvalid');
        const saved = await api.recordPayment(tenant.id, invoice.id, {
          amountPaise: paise,
          paidOn,
          mode,
          reference: reference.trim(),
        });
        await onSaved(saved);
        toast({
          title: t('platform.billing.recorded', { number: invoice.number }),
          tone: 'success',
        });
        return undefined;
      }}
    >
      <Field label={t('platform.billing.amount')} required>
        <Input
          inputMode="decimal"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
          }}
        />
      </Field>
      <Field label={t('platform.billing.paidOn')} required>
        <Input
          type="date"
          value={paidOn}
          onChange={(event) => {
            setPaidOn(event.target.value);
          }}
        />
      </Field>
      <Field label={t('platform.billing.mode')}>
        <Select
          value={mode}
          onChange={(event) => {
            setMode(event.target.value as SubscriptionPaymentMode);
          }}
        >
          {SUBSCRIPTION_PAYMENT_MODES.map((key) => (
            <option key={key} value={key}>
              {t(`platform.billing.modes.${key}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('platform.billing.reference')} required>
        <Input
          maxLength={100}
          value={reference}
          onChange={(event) => {
            setReference(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

function InvoiceRows({
  tenant,
  billing,
  onSaved,
}: {
  readonly tenant: TenantDetail;
  readonly billing: TenantBillingView;
  readonly onSaved: (saved: TenantBillingView) => Promise<void>;
}) {
  const { t, date, money } = useI18n();
  const [paying, setPaying] = useState<SubscriptionInvoiceView | null>(null);
  if (billing.invoices.length === 0) return <EmptyState title={t('platform.billing.noInvoices')} />;
  return (
    <>
      <Table label={t('platform.billing.invoices')}>
        <thead>
          <tr>
            <th scope="col">{t('subscription.number')}</th>
            <th scope="col">{t('subscription.period')}</th>
            <th scope="col">{t('subscription.total')}</th>
            <th scope="col">{t('subscription.status')}</th>
            <th scope="col">
              <span className="ui-visually-hidden">{t('platform.billing.record')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {billing.invoices.map((invoice) => (
            <tr key={invoice.id}>
              <th scope="row">{invoice.number}</th>
              <td>
                {t('subscription.periodRange', {
                  from: date(invoice.periodStart),
                  to: date(invoice.periodEnd),
                })}
              </td>
              <td>{money(invoice.totalPaise)}</td>
              <td>
                <InvoiceStatus invoice={invoice} />
                {invoice.payment !== null && invoice.payment.amountPaise < invoice.totalPaise && (
                  <span className="cell-meta">
                    {t('platform.billing.short', {
                      amount: money(invoice.totalPaise - invoice.payment.amountPaise),
                    })}
                  </span>
                )}
              </td>
              <td>
                {invoice.payment === null && (
                  <Button
                    size="sm"
                    aria-label={`${t('platform.billing.record')}: ${invoice.number}`}
                    onClick={() => {
                      setPaying(invoice);
                    }}
                  >
                    {t('platform.billing.record')}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {paying !== null && (
        <RecordPaymentDialog
          tenant={tenant}
          invoice={paying}
          onClose={() => {
            setPaying(null);
          }}
          onSaved={onSaved}
        />
      )}
    </>
  );
}

/**
 * Manual invoicing in the console: the plan the owner asked for (apply or decline),
 * our invoices to the business, and recording the money that arrived for one.
 */
export function TenantBillingCard({ tenant }: { readonly tenant: TenantDetail }) {
  const { t, date } = useI18n();
  const api = usePlatformApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const billing = useQuery({
    queryKey: billingKey(tenant.id),
    queryFn: ({ signal }) => api.billing(tenant.id, signal),
  });
  const saved = async (next: TenantBillingView) => {
    queryClient.setQueryData(billingKey(tenant.id), next);
    // The plan and the subscription change with a payment or an applied request.
    await queryClient.invalidateQueries({ queryKey: [PLATFORM_QUERY, 'tenant', tenant.id] });
    await queryClient.invalidateQueries({ queryKey: [PLATFORM_QUERY, 'tenants'] });
  };
  const decide = useMutation({
    mutationFn: ({ id, apply }: { id: string; apply: boolean }) =>
      apply ? api.applyRequest(tenant.id, id) : api.declineRequest(tenant.id, id),
    onSuccess: async (next, { apply }) => {
      await saved(next);
      toast({
        title: t(apply ? 'platform.billing.applied' : 'platform.billing.declined'),
        tone: 'success',
      });
    },
    onError: (error) => {
      toast({ title: errorMessage(error), tone: 'danger' });
    },
  });
  return (
    <Card title={t('platform.billing.title')}>
      <QueryState query={billing} error="platform.billing.error">
        {(view) =>
          view.collection !== 'manual' ? (
            <p className="muted">{t('platform.billing.online', { gateway: view.collection })}</p>
          ) : (
            <div className="stack">
              <p className="muted">{t('platform.billing.hint')}</p>
              {view.planRequest !== null && (
                <Alert tone="info">
                  <div className="stack">
                    <span>
                      {t('platform.billing.request', {
                        plan: PLANS[view.planRequest.plan].name,
                        interval: t(`subscription.intervals.${view.planRequest.interval}`),
                        name: view.planRequest.requestedBy,
                        date: date(view.planRequest.createdAt),
                      })}
                    </span>
                    <div className="row">
                      <Button
                        size="sm"
                        loading={decide.isPending}
                        onClick={() => {
                          decide.mutate({ id: String(view.planRequest?.id), apply: true });
                        }}
                      >
                        {t('platform.billing.apply')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={decide.isPending}
                        onClick={() => {
                          decide.mutate({ id: String(view.planRequest?.id), apply: false });
                        }}
                      >
                        {t('platform.billing.decline')}
                      </Button>
                    </div>
                  </div>
                </Alert>
              )}
              <InvoiceRows tenant={tenant} billing={view} onSaved={saved} />
            </div>
          )
        }
      </QueryState>
    </Card>
  );
}
