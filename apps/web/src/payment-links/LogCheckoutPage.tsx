import { Alert, Badge, Button, Card, Field, Input } from '@paint/ui';
import { paiseToRupees, type LogWebhook } from '@paint/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { parseRupees } from '../lib/inputs.js';
import { QueryState } from '../lib/QueryState.js';
import { LINK_STATUS_TONE } from './PaymentLinks.js';

type Outcome = 'applied' | 'duplicate' | 'ignored';

/**
 * /pay/:reference — the `log` provider's test payment page (development, e2e and
 * demos; the provider is refused in production). Paying asks the API for the webhook
 * the gateway would send, signed, and posts it to the webhook route as a gateway
 * would; "send again" posts the very same webhook, which changes nothing.
 */
export function LogCheckoutPage() {
  const api = useApi();
  const { t, label, money, dateTime } = useI18n();
  const queryClient = useQueryClient();
  // The route always has a :reference.
  const reference = String(useParams().reference);
  const [amount, setAmount] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ webhook: LogWebhook; outcome: Outcome } | null>(null);
  const checkout = useQuery({
    queryKey: ['log-checkout', reference],
    queryFn: ({ signal }) => api.paymentLinks.logCheckout(reference, signal),
  });

  const deliver = async (make: () => Promise<LogWebhook>) => {
    setBusy(true);
    setFailure(null);
    try {
      const webhook = await make();
      const { received } = await api.paymentLinks.deliver(webhook);
      setSent({ webhook, outcome: received });
      await queryClient.invalidateQueries({ queryKey: ['log-checkout', reference] });
    } catch (problem) {
      setFailure(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="sign-in" id="main">
      <Card className="sign-in__card" title={t('logCheckout.title')}>
        <QueryState query={checkout} error="logCheckout.error">
          {(link) => {
            const left = Math.max(link.amountPaise - link.paidPaise, 0);
            const text = amount ?? paiseToRupees(left === 0 ? link.amountPaise : left);
            const facts: [string, string][] = [
              [t('logCheckout.business'), link.business],
              [t('logCheckout.customer'), link.partyName],
              [t('logCheckout.link'), `${link.number} · ${dateTime(link.expiresAt)}`],
              [t('logCheckout.for'), link.description],
              [t('logCheckout.amount'), money(link.amountPaise)],
              [t('logCheckout.paid'), money(link.paidPaise)],
            ];
            return (
              <div className="stack">
                <Alert tone="info">{t('logCheckout.notice')}</Alert>
                <dl className="facts">
                  {facts.map(([name, value]) => (
                    <div key={name}>
                      <dt>{name}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                  <div>
                    <dt>{t('logCheckout.status')}</dt>
                    <dd>
                      <Badge tone={LINK_STATUS_TONE[link.status]}>
                        {label('paymentLinkStatus', link.status)}
                      </Badge>
                    </dd>
                  </div>
                </dl>
                {failure !== null && <Alert tone="danger">{failure}</Alert>}
                {sent !== null && (
                  <Alert tone={sent.outcome === 'applied' ? 'success' : 'info'}>
                    {t(`logCheckout.${sent.outcome}`)}
                  </Alert>
                )}
                <Field label={t('logCheckout.payAmount')} error={error}>
                  <Input
                    inputMode="decimal"
                    value={text}
                    onChange={(event) => {
                      setAmount(event.target.value);
                    }}
                  />
                </Field>
                <div className="row">
                  <Button
                    loading={busy}
                    onClick={() => {
                      const paise = parseRupees(text);
                      if (paise === null || paise <= 0) {
                        setError(t('logCheckout.amountInvalid'));
                        return;
                      }
                      setError(undefined);
                      void deliver(() => api.paymentLinks.logPay(reference, paise));
                    }}
                  >
                    {t('logCheckout.pay')}
                  </Button>
                  {sent !== null && (
                    <Button
                      variant="secondary"
                      loading={busy}
                      onClick={() => {
                        void deliver(() => Promise.resolve(sent.webhook));
                      }}
                    >
                      {t('logCheckout.replay')}
                    </Button>
                  )}
                </div>
              </div>
            );
          }}
        </QueryState>
      </Card>
    </main>
  );
}
