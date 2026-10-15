import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BillingInterval, PaidPlanKey, PaymentGatewayName } from '@paint/shared';

/** Injection token for the PaymentGateway the API uses. */
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

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

/** What a gateway event means for us. Anything else is `ignored`. */
export type GatewayEventType = 'activated' | 'charged' | 'payment_failed' | 'cancelled' | 'ignored';

/** A webhook event, verified and translated from the gateway's own format. */
export interface GatewayEvent {
  /** Unique per gateway: the same event delivered twice is applied once. */
  readonly id: string;
  readonly type: GatewayEventType;
  /** The gateway's own name for the event, kept with it. */
  readonly gatewayType: string;
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
 * A payment gateway for SaaS subscriptions (roadmap P2-M08; architecture: every
 * external integration sits behind an adapter). Webhook bodies are verified
 * before anything in them is believed.
 */
export interface PaymentGateway {
  readonly name: PaymentGatewayName;
  createSubscription(input: NewGatewaySubscription): Promise<CreatedGatewaySubscription>;
  /** Moves a running subscription to another plan or store count from its next period. */
  changePlan(
    gatewaySubscriptionId: string,
    change: { plan: PaidPlanKey; interval: BillingInterval; quantity: number },
  ): Promise<void>;
  /** Stops renewal: the paid period runs to its end. */
  cancelAtPeriodEnd(gatewaySubscriptionId: string): Promise<void>;
  fetchSubscription(gatewaySubscriptionId: string): Promise<GatewaySubscriptionStatus>;
  /** The event in a webhook, or null when its signature does not match the body. */
  verifyWebhook(rawBody: Buffer, headers: Readonly<Record<string, unknown>>): GatewayEvent | null;
}

/** Hex HMAC-SHA256 of `body`, as Razorpay signs webhooks. */
export function hmacHex(secret: string, body: Buffer | string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** True when `signature` is the HMAC of `body`; compared in constant time. */
export function signatureMatches(secret: string, body: Buffer, signature: unknown): boolean {
  if (typeof signature !== 'string') return false;
  const expected = Buffer.from(hmacHex(secret, body), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Thrown when the gateway refuses or cannot be reached; never carries keys. */
export class GatewayError extends Error {
  override readonly name = 'GatewayError';
}
