import type { BillingInterval, PaidPlanKey } from '@paint/shared';
import type { VerifiedGatewayEvent, WebhookVerifier } from '../payments-gateway/payment-gateway.js';

/** Injection token for the SubscriptionGateway the API uses. */
export const SUBSCRIPTION_GATEWAY = Symbol('SUBSCRIPTION_GATEWAY');

/** A recurring payment to start at the gateway for a business's new plan. */
export interface NewGatewaySubscription {
  /** Our checkout's id, kept in the gateway's notes. */
  readonly checkoutId: string;
  readonly organizationId: string;
  readonly plan: PaidPlanKey;
  readonly interval: BillingInterval;
  /** Stores billed; the gateway's plan is priced per store. */
  readonly quantity: number;
  /** One period's total, GST included, as we expect the gateway to collect it. */
  readonly totalPaise: number;
}

export interface CreatedGatewaySubscription {
  readonly gatewaySubscriptionId: string;
  /** Where the owner pays the first period. */
  readonly checkoutUrl: string;
}

/** What a gateway event means for a subscription. Anything else is `ignored`. */
export type SubscriptionEventType =
  'activated' | 'charged' | 'payment_failed' | 'cancelled' | 'ignored';

/** A subscription webhook event, verified and translated from the gateway's own format. */
export interface SubscriptionGatewayEvent extends VerifiedGatewayEvent {
  readonly type: SubscriptionEventType;
  readonly gatewaySubscriptionId: string | null;
  /** For `charged`: the payment, invoiced once. */
  readonly paymentId: string | null;
  readonly amountPaise: number | null;
  /** The paid period, when the gateway says; null = from now for one interval. */
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
}

/** The gateway's view of a subscription, for checking on one. */
export interface GatewaySubscriptionStatus {
  readonly id: string;
  /** As the gateway names it, e.g. Razorpay's created, active, pending, halted, cancelled. */
  readonly status: string;
  readonly currentStart: Date | null;
  readonly currentEnd: Date | null;
}

/**
 * A payment gateway that collects SaaS subscriptions (roadmap P2-M08), on the
 * shared payment-gateway port (apps/api/src/payments-gateway): webhook bodies are
 * verified before anything in them is believed, and each event is stored once.
 */
export interface SubscriptionGateway extends WebhookVerifier<SubscriptionGatewayEvent> {
  createSubscription(input: NewGatewaySubscription): Promise<CreatedGatewaySubscription>;
  /** Moves a running subscription to another plan or store count from its next period. */
  changePlan(
    gatewaySubscriptionId: string,
    change: { plan: PaidPlanKey; interval: BillingInterval; quantity: number },
  ): Promise<void>;
  /** Stops renewal: the paid period runs to its end. */
  cancelAtPeriodEnd(gatewaySubscriptionId: string): Promise<void>;
  fetchSubscription(gatewaySubscriptionId: string): Promise<GatewaySubscriptionStatus>;
}
