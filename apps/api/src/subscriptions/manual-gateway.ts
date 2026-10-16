import { GatewayError } from '../payments-gateway/payment-gateway.js';
import type {
  CreatedGatewaySubscription,
  GatewaySubscriptionStatus,
  SubscriptionGateway,
  SubscriptionGatewayEvent,
} from './subscription-gateway.js';

/**
 * Manual invoicing, the default (SUBSCRIPTION_GATEWAY=manual): no gateway at all.
 * The owner asks for a plan, a platform operator applies it, we raise our GST
 * invoices on schedule and an operator records the bank transfer or UPI payment
 * (SubscriptionsService). Nothing is ever started here and no webhook is believed.
 */
export class ManualGateway implements SubscriptionGateway {
  readonly name = 'manual' as const;

  createSubscription(): Promise<CreatedGatewaySubscription> {
    return Promise.reject(new GatewayError('Manual invoicing has no online checkout'));
  }

  /** The next invoice carries the new plan; there is nobody else to tell. */
  changePlan(): Promise<void> {
    return Promise.resolve();
  }

  /** No more invoices are raised; there is nobody else to tell. */
  cancelAtPeriodEnd(): Promise<void> {
    return Promise.resolve();
  }

  fetchSubscription(): Promise<GatewaySubscriptionStatus> {
    return Promise.reject(new GatewayError('Manual invoicing has no gateway subscriptions'));
  }

  verifyWebhook(): SubscriptionGatewayEvent | null {
    return null;
  }
}
