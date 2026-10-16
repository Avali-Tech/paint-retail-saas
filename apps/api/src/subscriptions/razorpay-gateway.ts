import type { BillingInterval, PaidPlanKey } from '@paint/shared';
import type { GatewayConfig } from '../config.js';
import {
  GatewayError,
  signatureMatches,
  type CreatedGatewaySubscription,
  type GatewayEvent,
  type GatewayEventType,
  type GatewaySubscriptionStatus,
  type NewGatewaySubscription,
  type PaymentGateway,
} from './payment-gateway.js';

export type RazorpayConfig = Extract<GatewayConfig, { name: 'razorpay' }>;
type Fetch = typeof globalThis.fetch;

/** Periods a subscription runs for before Razorpay ends it (it needs a count): ten years. */
const TOTAL_COUNT: Record<BillingInterval, number> = { monthly: 120, annual: 10 };

/** Razorpay's webhook events and what each means for us. */
const EVENT_TYPES: Readonly<Record<string, GatewayEventType>> = {
  'subscription.activated': 'activated',
  'subscription.charged': 'charged',
  // A renewal failed and Razorpay retries (pending), or gave up (halted).
  'subscription.pending': 'payment_failed',
  'subscription.halted': 'payment_failed',
  'subscription.cancelled': 'cancelled',
  'subscription.completed': 'cancelled',
};

interface RazorpaySubscription {
  readonly id: string;
  readonly status: string;
  readonly short_url?: string;
  readonly current_start?: number | null;
  readonly current_end?: number | null;
}

interface RazorpayWebhook {
  readonly event: string;
  readonly created_at: number;
  readonly payload: {
    readonly subscription?: { readonly entity: RazorpaySubscription };
    readonly payment?: { readonly entity: { readonly id: string; readonly amount: number } };
  };
}

const fromUnix = (seconds: number | null | undefined) =>
  typeof seconds === 'number' ? new Date(seconds * 1000) : null;

/**
 * Razorpay Subscriptions (https://razorpay.com/docs/api/payments/subscriptions/),
 * driven only by configuration: keys, webhook secret and one Razorpay plan per paid
 * plan and interval (priced per store, GST included), all from the environment.
 * Plain fetch with Basic auth; nothing here ever logs or returns a key.
 */
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay' as const;

  constructor(
    private readonly config: RazorpayConfig,
    private readonly fetch: Fetch = globalThis.fetch,
  ) {}

  async createSubscription(input: NewGatewaySubscription): Promise<CreatedGatewaySubscription> {
    const created = await this.call<RazorpaySubscription>('POST', '/subscriptions', {
      plan_id: this.planId(input.plan, input.interval),
      total_count: TOTAL_COUNT[input.interval],
      quantity: input.quantity,
      customer_notify: 1,
      notes: { organization_id: input.organizationId, checkout_id: input.checkoutId },
    });
    if (!created.short_url) throw new GatewayError('Razorpay gave no payment link');
    return { gatewaySubscriptionId: created.id, checkoutUrl: created.short_url };
  }

  async changePlan(
    gatewaySubscriptionId: string,
    change: { plan: PaidPlanKey; interval: BillingInterval; quantity: number },
  ): Promise<void> {
    await this.call('PATCH', `/subscriptions/${encodeURIComponent(gatewaySubscriptionId)}`, {
      plan_id: this.planId(change.plan, change.interval),
      quantity: change.quantity,
      schedule_change_at: 'cycle_end',
      customer_notify: 1,
    });
  }

  async cancelAtPeriodEnd(gatewaySubscriptionId: string): Promise<void> {
    await this.call('POST', `/subscriptions/${encodeURIComponent(gatewaySubscriptionId)}/cancel`, {
      cancel_at_cycle_end: 1,
    });
  }

  async fetchSubscription(gatewaySubscriptionId: string): Promise<GatewaySubscriptionStatus> {
    const found = await this.call<RazorpaySubscription>(
      'GET',
      `/subscriptions/${encodeURIComponent(gatewaySubscriptionId)}`,
    );
    return {
      id: found.id,
      status: found.status,
      currentStart: fromUnix(found.current_start),
      currentEnd: fromUnix(found.current_end),
    };
  }

  verifyWebhook(rawBody: Buffer, headers: Readonly<Record<string, unknown>>): GatewayEvent | null {
    if (!signatureMatches(this.config.webhookSecret, rawBody, headers['x-razorpay-signature'])) {
      return null;
    }
    const webhook = JSON.parse(rawBody.toString('utf8')) as RazorpayWebhook;
    const subscription = webhook.payload.subscription?.entity ?? null;
    const payment = webhook.payload.payment?.entity ?? null;
    const eventId = headers['x-razorpay-event-id'];
    return {
      // Razorpay names each event in a header; older deliveries are told apart by content.
      id:
        typeof eventId === 'string' && eventId !== ''
          ? eventId
          : [webhook.event, subscription?.id, payment?.id ?? webhook.created_at].join(':'),
      type: EVENT_TYPES[webhook.event] ?? 'ignored',
      gatewayType: webhook.event,
      gatewaySubscriptionId: subscription?.id ?? null,
      paymentId: payment?.id ?? null,
      amountPaise: payment?.amount ?? null,
      periodStart: fromUnix(subscription?.current_start),
      periodEnd: fromUnix(subscription?.current_end),
    };
  }

  private planId(plan: PaidPlanKey, interval: BillingInterval): string {
    return this.config.planIds[`${plan}_${interval}`];
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const credentials = Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString(
      'base64',
    );
    let response: Response;
    try {
      response = await this.fetch(`${this.config.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Basic ${credentials}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GatewayError(`Razorpay could not be reached (${method} ${path})`);
    }
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      throw new GatewayError(
        `Razorpay answered ${String(response.status)} (${error?.error?.code ?? 'no code'}) to ${method} ${path}`,
      );
    }
    return (await response.json()) as T;
  }
}
