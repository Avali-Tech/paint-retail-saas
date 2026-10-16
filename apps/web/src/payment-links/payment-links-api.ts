import type {
  CreatePaymentLinkRequest,
  LogCheckoutView,
  LogWebhook,
  PaymentLinkCreated,
  PaymentLinkPage,
  PaymentLinkSettings,
  PaymentLinkStatus,
  PaymentLinkView,
} from '@paint/shared';
import type { ApiClient } from '../api/client.js';

// UPI payment links (apps/api/src/payment-links). Shapes come from @paint/shared.

export interface PaymentLinkFilters {
  readonly partyId?: string | undefined;
  readonly invoiceId?: string | undefined;
  readonly status?: PaymentLinkStatus | undefined;
  readonly limit: number;
  readonly offset: number;
}

export function paymentLinkEndpoints(api: ApiClient) {
  return {
    settings: (signal?: AbortSignal) =>
      api.get<PaymentLinkSettings>('/payment-links/settings', { signal }),
    /** One link per key: a retried click never makes a second link. */
    create: (body: CreatePaymentLinkRequest, idempotencyKey: string) =>
      api.post<PaymentLinkCreated>('/payment-links', body, {
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    list: (filters: PaymentLinkFilters, signal?: AbortSignal) =>
      api.get<PaymentLinkPage>('/payment-links', { query: { ...filters }, signal }),
    cancel: (id: string) => api.post<PaymentLinkView>(`/payment-links/${id}/cancel`),
    /** The log provider's test checkout page (development and demos). */
    logCheckout: (reference: string, signal?: AbortSignal) =>
      api.get<LogCheckoutView>(`/public/payment-links/log/${reference}`, { signal }),
    logPay: (reference: string, amountPaise: number) =>
      api.post<LogWebhook>(`/public/payment-links/log/${reference}/pay`, { amountPaise }),
    /**
     * Posts the signed webhook as the gateway would. The body is sent as it was signed:
     * JSON.stringify of the parsed body gives back the same text.
     */
    deliver: (webhook: LogWebhook) =>
      api.post<{ received: 'applied' | 'duplicate' | 'ignored' }>(
        webhook.path,
        JSON.parse(webhook.body) as unknown,
        { headers: { [webhook.header]: webhook.signature } },
      ),
  };
}
