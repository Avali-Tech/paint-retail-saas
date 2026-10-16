import {
  BILLING_INTERVALS,
  PLANS,
  isUpgrade,
  type BillingInterval,
  type PlanOffer,
  type SubscriptionInvoiceView,
  type SubscriptionView,
} from '@paint/shared';
import { Alert, Badge, Button, Card, Field, PageHeader, Select, Table, useToast } from '@paint/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { Facts } from '../leads/Facts.js';
import { saveFile } from '../lib/download.js';
import { FormDialog } from '../lib/FormDialog.js';
import { QueryState } from '../lib/QueryState.js';
import { STATUS_TONES, SUBSCRIPTION_QUERY } from './billing-api.js';
import { InvoiceStatus, PaymentInstructionsCard } from './invoice-parts.js';
import { OwnerOnly } from './OwnerOnly.js';

function StatusCard({ view }: { readonly view: SubscriptionView }) {
  const { t, plural, date } = useI18n();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [cancelling, setCancelling] = useState(false);
  const periodEnd = view.currentPeriodEnd === null ? null : date(view.currentPeriodEnd);
  const canCancel = view.status === 'active' && view.gateway !== null && !view.cancelAtPeriodEnd;
  return (
    <Card
      title={t('subscription.current')}
      actions={
        canCancel ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setCancelling(true);
            }}
          >
            {t('subscription.cancel')}
          </Button>
        ) : undefined
      }
    >
      <div className="stack">
        <p>
          <strong>{view.planName}</strong>{' '}
          <Badge tone={STATUS_TONES[view.status]}>
            {t(`subscription.statuses.${view.status}`)}
          </Badge>
        </p>
        <Facts
          facts={[
            [
              t('subscription.trialEnds'),
              view.trialEndsAt === null
                ? null
                : view.trialDaysLeft === null
                  ? date(view.trialEndsAt)
                  : `${date(view.trialEndsAt)} · ${plural('subscription.trialLeft', view.trialDaysLeft)}`,
            ],
            [
              view.cancelAtPeriodEnd ? t('subscription.periodEnds') : t('subscription.renews'),
              view.gateway === null ? null : periodEnd,
            ],
            [
              t('subscription.billed'),
              view.interval === null || view.quantity === null
                ? null
                : `${t(`subscription.intervals.${view.interval}`)} · ${plural('subscription.billedStores', view.quantity)}`,
            ],
            [
              t('subscription.collection'),
              view.plan === 'trial'
                ? null
                : view.gateway === null
                  ? t('subscription.manual')
                  : view.gateway === 'manual'
                    ? t('subscription.invoiced')
                    : t('subscription.online'),
            ],
          ]}
        />
        {view.readOnly && <Alert tone="danger">{t('subscription.readOnly')}</Alert>}
        {view.status === 'past_due' && !view.readOnly && (
          <Alert tone="warning">
            {t('subscription.pastDue', { date: date(String(view.graceEndsAt)) })}
          </Alert>
        )}
        {view.cancelAtPeriodEnd && view.status === 'active' && (
          <Alert tone="info">{t('subscription.cancelling', { date: String(periodEnd) })}</Alert>
        )}
        {view.plan !== 'trial' && view.gateway === null && view.status === 'active' && (
          <p className="muted">
            {view.collection === 'manual'
              ? t('subscription.manualHintRequest')
              : t('subscription.manualHint')}
          </p>
        )}
        {view.planRequest !== null && (
          <Alert tone="info">
            {t('subscription.requestPending', {
              plan: PLANS[view.planRequest.plan].name,
              interval: t(`subscription.intervals.${view.planRequest.interval}`),
              date: date(view.planRequest.createdAt),
            })}
          </Alert>
        )}
      </div>
      {cancelling && (
        <FormDialog
          open
          onClose={() => {
            setCancelling(false);
          }}
          title={t('subscription.cancelTitle')}
          description={t('subscription.cancelHint', { date: String(periodEnd) })}
          submitLabel={t('subscription.cancelConfirm')}
          onSubmit={async () => {
            const saved = await api.subscription.cancel();
            queryClient.setQueryData([SUBSCRIPTION_QUERY, 'view'], saved);
            await queryClient.invalidateQueries({ queryKey: [SUBSCRIPTION_QUERY, 'status'] });
            toast({
              title: t('subscription.cancelled', { date: date(String(saved.currentPeriodEnd)) }),
              tone: 'success',
            });
            return undefined;
          }}
        >
          {null}
        </FormDialog>
      )}
    </Card>
  );
}

function UsageCard({ view }: { readonly view: SubscriptionView }) {
  const { t, number } = useI18n();
  const usage = (used: number, limit: number | null) =>
    limit === null
      ? t('subscription.unlimited', { used: number(used) })
      : t('subscription.usage', { used: number(used), limit: number(limit) });
  return (
    <Card title={t('subscription.usageTitle')}>
      <Facts
        facts={[
          [t('subscription.stores'), usage(view.usage.stores, view.limits.maxStores)],
          [t('subscription.members'), usage(view.usage.members, view.limits.maxMembers)],
        ]}
      />
    </Card>
  );
}

function OfferCard({
  view,
  offer,
  interval,
  busy,
  onChoose,
}: {
  readonly view: SubscriptionView;
  readonly offer: PlanOffer;
  readonly interval: BillingInterval;
  readonly busy: boolean;
  readonly onChoose: () => void;
}) {
  const { t, money, number } = useI18n();
  const charge = offer.charges[interval];
  const current =
    offer.plan === view.plan &&
    interval === view.interval &&
    view.status === 'active' &&
    !view.cancelAtPeriodEnd;
  const requested =
    view.planRequest !== null &&
    view.planRequest.plan === offer.plan &&
    view.planRequest.interval === interval;
  const label = current
    ? t('subscription.currentPlan')
    : requested
      ? t('subscription.requestedPlan')
      : offer.plan === view.plan
        ? t('subscription.choose')
        : isUpgrade(view.plan, offer.plan)
          ? t('subscription.upgrade')
          : t('subscription.downgrade');
  return (
    <li>
      <strong>{offer.name}</strong>
      <span>{t(`subscription.perStore.${interval}`, { price: money(charge.unitPricePaise) })}</span>
      <span className="cell-meta">
        {offer.maxStores === null || offer.maxMembers === null
          ? t('subscription.noLimits')
          : t('subscription.limits', {
              stores: number(offer.maxStores),
              members: number(offer.maxMembers),
            })}
      </span>
      <span>
        {t('subscription.charge', {
          taxable: money(charge.taxablePaise),
          gst: money(charge.gstPaise),
          total: money(charge.totalPaise),
        })}
      </span>
      {offer.blockers.map((blocker) => (
        <span key={blocker.what} className="cell-meta">
          {t(`subscription.blockers.${blocker.what}`, {
            used: number(blocker.used),
            limit: number(blocker.limit),
          })}
        </span>
      ))}
      <div className="row">
        <Button
          size="sm"
          variant={current ? 'secondary' : 'primary'}
          disabled={current || requested || busy || offer.blockers.length > 0}
          onClick={onChoose}
          aria-label={`${label}: ${offer.name}`}
        >
          {label}
        </Button>
      </div>
    </li>
  );
}

function PlansCard({ view }: { readonly view: SubscriptionView }) {
  const { t, plural } = useI18n();
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [interval, setInterval] = useState<BillingInterval>(view.interval ?? 'monthly');
  const change = useMutation({
    mutationFn: (plan: PlanOffer['plan']) => api.subscription.change({ plan, interval }),
    onSuccess: async (result) => {
      if (result.kind === 'requested') {
        toast({
          title: t('subscription.requested', { plan: PLANS[result.request.plan].name }),
          tone: 'success',
        });
        await queryClient.invalidateQueries({ queryKey: [SUBSCRIPTION_QUERY] });
        return;
      }
      if (result.kind === 'changed') {
        toast({
          title: t('subscription.changed', { plan: result.subscription.planName }),
          tone: 'success',
        });
        await queryClient.invalidateQueries({ queryKey: [SUBSCRIPTION_QUERY] });
        return;
      }
      if (result.checkout.gateway === 'fake') {
        void navigate(`/billing/checkout/${result.checkout.id}`);
        return;
      }
      // The gateway's own payment page, in place of the app.
      window.open(result.checkout.checkoutUrl, '_self');
    },
    onError: (error) => {
      toast({ title: errorMessage(error), tone: 'danger' });
    },
  });
  return (
    <Card title={t('subscription.plansTitle')}>
      <div className="stack">
        <p className="muted">
          {t('subscription.plansHint', {
            stores: plural('subscription.billedStores', Math.max(1, view.usage.stores)),
          })}
        </p>
        {view.collection === 'manual' && <p className="muted">{t('subscription.requestHint')}</p>}
        <Field label={t('subscription.interval')}>
          <Select
            value={interval}
            onChange={(event) => {
              setInterval(event.target.value as BillingInterval);
            }}
          >
            {BILLING_INTERVALS.map((value) => (
              <option key={value} value={value}>
                {t(`subscription.intervals.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
        <ul className="record-list">
          {view.offers.map((offer) => (
            <OfferCard
              key={offer.plan}
              view={view}
              offer={offer}
              interval={interval}
              busy={change.isPending}
              onChoose={() => {
                change.mutate(offer.plan);
              }}
            />
          ))}
        </ul>
      </div>
    </Card>
  );
}

function InvoicesCard() {
  const { t, date, money } = useI18n();
  const api = useApi();
  const toast = useToast();
  const invoices = useQuery({
    queryKey: [SUBSCRIPTION_QUERY, 'invoices'],
    queryFn: ({ signal }) => api.subscription.invoices(signal),
  });
  const download = (invoice: SubscriptionInvoiceView) => {
    api.subscription
      .invoicePdf(invoice.id)
      .then((file) => {
        saveFile(file.blob, file.fileName ?? `${invoice.number.replaceAll('/', '-')}.pdf`);
      })
      .catch((error: unknown) => {
        toast({ title: errorMessage(error), tone: 'danger' });
      });
  };
  return (
    <Card title={t('subscription.invoicesTitle')}>
      <QueryState query={invoices} error="subscription.error">
        {(list) =>
          list.length === 0 ? (
            <p className="muted">{t('subscription.invoicesEmpty')}</p>
          ) : (
            <Table label={t('subscription.invoices')}>
              <thead>
                <tr>
                  <th scope="col">{t('subscription.number')}</th>
                  <th scope="col">{t('subscription.date')}</th>
                  <th scope="col">{t('subscription.period')}</th>
                  <th scope="col">{t('subscription.plan')}</th>
                  <th scope="col">{t('subscription.total')}</th>
                  <th scope="col">{t('subscription.status')}</th>
                  <th scope="col">
                    <span className="ui-visually-hidden">{t('subscription.download')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((invoice) => (
                  <tr key={invoice.id}>
                    <th scope="row">{invoice.number}</th>
                    <td>{date(invoice.issuedOn)}</td>
                    <td>
                      {t('subscription.periodRange', {
                        from: date(invoice.periodStart),
                        to: date(invoice.periodEnd),
                      })}
                    </td>
                    <td>
                      {t('subscription.planInterval', {
                        plan: PLANS[invoice.plan].name,
                        interval: t(`subscription.intervals.${invoice.interval}`),
                      })}
                    </td>
                    <td>{money(invoice.totalPaise)}</td>
                    <td>
                      <InvoiceStatus invoice={invoice} />
                    </td>
                    <td>
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`${t('subscription.download')}: ${invoice.number}`}
                        onClick={() => {
                          download(invoice);
                        }}
                      >
                        {t('subscription.download')}
                      </Button>
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

function HistoryCard({ view }: { readonly view: SubscriptionView }) {
  const { t, dateTime } = useI18n();
  return (
    <Card title={t('subscription.historyTitle')}>
      <ul className="record-list">
        {view.history.map((change) => (
          <li key={change.id}>
            <strong>
              {change.fromPlan === null
                ? t('subscription.started', { plan: PLANS[change.toPlan].name })
                : t('subscription.movedTo', {
                    from: PLANS[change.fromPlan].name,
                    to: PLANS[change.toPlan].name,
                  })}
            </strong>
            <span className="cell-meta">
              {[
                t(`subscription.sources.${change.source}`, { name: String(change.changedBy) }),
                change.interval === null ? null : t(`subscription.intervals.${change.interval}`),
                dateTime(change.at),
              ]
                .filter((part) => part !== null)
                .join(' · ')}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function OwnerBilling() {
  const { t } = useI18n();
  const api = useApi();
  const subscription = useQuery({
    queryKey: [SUBSCRIPTION_QUERY, 'view'],
    queryFn: ({ signal }) => api.subscription.view(signal),
  });
  return (
    <>
      <PageHeader title={t('subscription.title')} description={t('subscription.description')} />
      <QueryState query={subscription} error="subscription.error">
        {(view) => (
          <div className="stack">
            <div className="detail-grid">
              <StatusCard view={view} />
              <UsageCard view={view} />
            </div>
            <PlansCard key={`${view.plan}-${String(view.interval)}`} view={view} />
            <InvoicesCard />
            {view.paymentInstructions !== null && (
              <PaymentInstructionsCard instructions={view.paymentInstructions} />
            )}
            <HistoryCard view={view} />
          </div>
        )}
      </QueryState>
    </>
  );
}

/**
 * /settings/billing — the owner's plan, usage against its limits, the plans to
 * move to (priced for the business's stores; with manual invoicing the owner asks
 * and our team applies), cancelling, our invoices with what is paid and due, how to
 * pay them, and the history of plan changes. Admins see who manages it.
 */
export function BillingPage() {
  return (
    <OwnerOnly>
      <OwnerBilling />
    </OwnerOnly>
  );
}
