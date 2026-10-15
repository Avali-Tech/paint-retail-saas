import type {
  BillingInterval,
  CheckoutView,
  PaidPlanKey,
  PlanChangeResult,
  SubscriptionInvoiceView,
  SubscriptionStatus,
  SubscriptionStatusView,
  SubscriptionView,
} from '@paint/shared';
import type { Tone } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../api/client.js';
import { useApi } from '../app/services.js';

/** The business's subscription (apps/api/src/subscriptions); all but status are for the owner. */
export function subscriptionEndpoints(api: ApiClient) {
  return {
    status: (signal?: AbortSignal) =>
      api.get<SubscriptionStatusView>('/subscription/status', { signal }),
    view: (signal?: AbortSignal) => api.get<SubscriptionView>('/subscription', { signal }),
    change: (input: { plan: PaidPlanKey; interval: BillingInterval }) =>
      api.post<PlanChangeResult>('/subscription/change', input),
    cancel: () => api.post<SubscriptionView>('/subscription/cancel'),
    checkout: (id: string, signal?: AbortSignal) =>
      api.get<CheckoutView>(`/subscription/checkouts/${id}`, { signal }),
    fakePay: (id: string) => api.post<CheckoutView>(`/subscription/checkouts/${id}/fake-pay`),
    invoices: (signal?: AbortSignal) =>
      api.get<SubscriptionInvoiceView[]>('/subscription/invoices', { signal }),
    invoicePdf: (id: string) => api.download(`/subscription/invoices/${id}/pdf`),
  };
}

/** Every subscription query starts with this, so one invalidation refreshes them all. */
export const SUBSCRIPTION_QUERY = 'subscription';

/** The subscription's status, for every member (the banner) and the billing screens. */
export function useSubscriptionStatus(refetchInterval: number) {
  const api = useApi();
  return useQuery({
    queryKey: [SUBSCRIPTION_QUERY, 'status'],
    queryFn: ({ signal }) => api.subscription.status(signal),
    refetchInterval,
  });
}

/** How each status stands out. */
export const STATUS_TONES: Readonly<Record<SubscriptionStatus, Tone>> = {
  trialing: 'info',
  active: 'success',
  past_due: 'warning',
  cancelled: 'neutral',
  expired: 'danger',
};
