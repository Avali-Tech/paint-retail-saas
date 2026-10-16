import { randomBytes, randomUUID } from 'node:crypto';
import type { BillingInterval, PaidPlanKey } from '@paint/shared';
import { hmacHex, signatureMatches } from '../payments-gateway/signatures.js';
import {
  type CreatedGatewaySubscription,
  type SubscriptionGatewayEvent,
  type SubscriptionEventType,
  type GatewaySubscriptionStatus,
  type NewGatewaySubscription,
  type SubscriptionGateway,
} from './subscription-gateway.js';

export const FAKE_SIGNATURE_HEADER = 'x-fake-gateway-signature';

/** The body the fake gateway sends: our own event shape, signed like Razorpay's. */
interface FakeEventBody {
  readonly id: string;
  readonly type: SubscriptionEventType;
  readonly subscriptionId: string;
  readonly paymentId: string | null;
  readonly amountPaise: number | null;
}

/**
 * A gateway that takes no money, for tests, e2e and the demo. Its checkout page is
 * a page of the web app (`/billing/checkout/:id`); "paying" there makes it send a
 * signed webhook that goes through exactly the checks a real one does. It signs
 * with a secret made fresh for each process, so nothing outside can forge one.
 */
export class FakeGateway implements SubscriptionGateway {
  readonly name = 'fake' as const;
  private readonly secret = randomBytes(32).toString('hex');
  /** What happened, for tests to look at. */
  readonly calls: { method: string; subscriptionId: string; detail?: unknown }[] = [];

  constructor(private readonly appUrl: string) {}

  createSubscription(input: NewGatewaySubscription): Promise<CreatedGatewaySubscription> {
    const gatewaySubscriptionId = `sub_fake_${randomUUID().replaceAll('-', '')}`;
    this.calls.push({ method: 'create', subscriptionId: gatewaySubscriptionId, detail: input });
    return Promise.resolve({
      gatewaySubscriptionId,
      checkoutUrl: `${this.appUrl}/billing/checkout/${input.checkoutId}`,
    });
  }

  changePlan(
    gatewaySubscriptionId: string,
    change: { plan: PaidPlanKey; interval: BillingInterval; quantity: number },
  ): Promise<void> {
    this.calls.push({ method: 'change', subscriptionId: gatewaySubscriptionId, detail: change });
    return Promise.resolve();
  }

  cancelAtPeriodEnd(gatewaySubscriptionId: string): Promise<void> {
    this.calls.push({ method: 'cancel', subscriptionId: gatewaySubscriptionId });
    return Promise.resolve();
  }

  fetchSubscription(gatewaySubscriptionId: string): Promise<GatewaySubscriptionStatus> {
    return Promise.resolve({
      id: gatewaySubscriptionId,
      status: 'active',
      currentStart: null,
      currentEnd: null,
    });
  }

  /** A webhook as the fake gateway would send it: the raw body and its signature header. */
  webhook(
    type: SubscriptionEventType,
    subscriptionId: string,
    payment: { amountPaise: number; id?: string } | null = null,
  ): { body: Buffer; headers: Record<string, string> } {
    const event: FakeEventBody = {
      id: `evt_fake_${randomUUID().replaceAll('-', '')}`,
      type,
      subscriptionId,
      paymentId: payment ? (payment.id ?? `pay_fake_${randomUUID().replaceAll('-', '')}`) : null,
      amountPaise: payment?.amountPaise ?? null,
    };
    const body = Buffer.from(JSON.stringify(event));
    return { body, headers: { [FAKE_SIGNATURE_HEADER]: hmacHex(this.secret, body) } };
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, unknown>>,
  ): SubscriptionGatewayEvent | null {
    if (!signatureMatches(this.secret, rawBody, headers[FAKE_SIGNATURE_HEADER])) return null;
    const event = JSON.parse(rawBody.toString('utf8')) as FakeEventBody;
    return {
      id: event.id,
      type: event.type,
      gatewayType: event.type,
      gatewaySubscriptionId: event.subscriptionId,
      paymentId: event.paymentId,
      amountPaise: event.amountPaise,
      periodStart: null,
      periodEnd: null,
    };
  }
}
