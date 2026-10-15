import { PLANS } from '@paint/shared';
import { Alert, Button, Card, PageHeader, buttonStyle, useToast } from '@paint/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { Facts } from '../leads/Facts.js';
import { QueryState } from '../lib/QueryState.js';
import { SUBSCRIPTION_QUERY } from './billing-api.js';
import { OwnerOnly } from './OwnerOnly.js';

function Checkout() {
  const { t, plural, money } = useI18n();
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id = '' } = useParams();
  const checkout = useQuery({
    queryKey: [SUBSCRIPTION_QUERY, 'checkout', id],
    queryFn: ({ signal }) => api.subscription.checkout(id, signal),
  });
  const pay = useMutation({
    mutationFn: () => api.subscription.fakePay(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [SUBSCRIPTION_QUERY] });
      toast({ title: t('subscription.checkout.paid'), tone: 'success' });
      void navigate('/settings/billing');
    },
    onError: (error) => {
      toast({ title: errorMessage(error), tone: 'danger' });
    },
  });
  const back = (
    <Link to="/settings/billing" {...buttonStyle('secondary')}>
      {t('subscription.checkout.back')}
    </Link>
  );
  return (
    <>
      <PageHeader title={t('subscription.checkout.title')} />
      <QueryState query={checkout} error="subscription.checkout.error">
        {(found) => (
          <Card>
            <div className="stack">
              <Alert tone="info" title={t('subscription.checkout.test')}>
                {t('subscription.checkout.testHint')}
              </Alert>
              <Facts
                facts={[
                  [t('subscription.checkout.plan'), PLANS[found.plan].name],
                  [
                    t('subscription.checkout.interval'),
                    t(`subscription.intervals.${found.interval}`),
                  ],
                  [
                    t('subscription.checkout.stores'),
                    plural('subscription.billedStores', found.quantity),
                  ],
                  [t('subscription.checkout.total'), money(found.totalPaise)],
                ]}
              />
              {found.status === 'paid' ? (
                <>
                  <Alert tone="success">{t('subscription.checkout.alreadyPaid')}</Alert>
                  <div className="row">{back}</div>
                </>
              ) : (
                <div className="row">
                  <Button
                    loading={pay.isPending}
                    onClick={() => {
                      pay.mutate();
                    }}
                  >
                    {t('subscription.checkout.pay', { amount: money(found.totalPaise) })}
                  </Button>
                  {back}
                </div>
              )}
            </div>
          </Card>
        )}
      </QueryState>
    </>
  );
}

/**
 * /billing/checkout/:id — the fake payment gateway's page (demo, tests): it takes no
 * money; paying sends the signed webhook a real gateway would, and the plan changes.
 */
export function FakeCheckoutPage() {
  return (
    <OwnerOnly>
      <Checkout />
    </OwnerOnly>
  );
}
