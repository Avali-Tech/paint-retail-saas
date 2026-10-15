import { describe, expect, it } from 'vitest';
import { GatewayError, hmacHex, signatureMatches } from './payment-gateway.js';
import { RazorpayGateway, type RazorpayConfig } from './razorpay-gateway.js';

const CONFIG: RazorpayConfig = {
  name: 'razorpay',
  keyId: 'rzp_test_key',
  keySecret: 'key-secret-value',
  webhookSecret: 'webhook-secret-value',
  apiUrl: 'https://api.razorpay.test/v1',
  planIds: {
    starter_monthly: 'plan_SM',
    starter_annual: 'plan_SA',
    standard_monthly: 'plan_GM',
    standard_annual: 'plan_GA',
    enterprise_monthly: 'plan_EM',
    enterprise_annual: 'plan_EA',
  },
};

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** A fetch that answers from `reply` and records every call: no network. */
function fakeFetch(reply: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const call: Sent = {
      url,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    sent.push(call);
    return reply(call);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const BASIC = `Basic ${Buffer.from('rzp_test_key:key-secret-value').toString('base64')}`;

describe('RazorpayGateway calls', () => {
  it('creates a subscription on the plan for the interval, per store, and answers its payment link', async () => {
    const { fetch, sent } = fakeFetch(() =>
      json({ id: 'sub_1', status: 'created', short_url: 'https://rzp.io/i/abc' }),
    );
    const gateway = new RazorpayGateway(CONFIG, fetch);
    expect(
      await gateway.createSubscription({
        checkoutId: 'checkout-1',
        organizationId: 'org-1',
        plan: 'standard',
        interval: 'annual',
        quantity: 3,
        totalPaise: 53_064_60,
      }),
    ).toEqual({ gatewaySubscriptionId: 'sub_1', checkoutUrl: 'https://rzp.io/i/abc' });
    expect(sent).toEqual([
      {
        url: 'https://api.razorpay.test/v1/subscriptions',
        method: 'POST',
        headers: { authorization: BASIC, 'content-type': 'application/json' },
        body: {
          plan_id: 'plan_GA',
          total_count: 10,
          quantity: 3,
          customer_notify: 1,
          notes: { organization_id: 'org-1', checkout_id: 'checkout-1' },
        },
      },
    ]);
  });

  it('changes the plan from the next cycle, cancels at cycle end and fetches status', async () => {
    const { fetch, sent } = fakeFetch((call) =>
      call.method === 'GET'
        ? json({ id: 'sub_1', status: 'active', current_start: 1_790_000_000, current_end: null })
        : json({ id: 'sub_1' }),
    );
    const gateway = new RazorpayGateway(CONFIG, fetch);
    await gateway.changePlan('sub_1', { plan: 'enterprise', interval: 'monthly', quantity: 2 });
    await gateway.cancelAtPeriodEnd('sub_1');
    expect(await gateway.fetchSubscription('sub_1')).toEqual({
      id: 'sub_1',
      status: 'active',
      currentStart: new Date(1_790_000_000_000),
      currentEnd: null,
    });
    expect(sent.map(({ url, method, body }) => [method, url, body])).toEqual([
      [
        'PATCH',
        'https://api.razorpay.test/v1/subscriptions/sub_1',
        { plan_id: 'plan_EM', quantity: 2, schedule_change_at: 'cycle_end', customer_notify: 1 },
      ],
      [
        'POST',
        'https://api.razorpay.test/v1/subscriptions/sub_1/cancel',
        { cancel_at_cycle_end: 1 },
      ],
      ['GET', 'https://api.razorpay.test/v1/subscriptions/sub_1', undefined],
    ]);
    expect(sent[2]?.headers).toEqual({ authorization: BASIC });
  });

  it('reports refusals and outages without ever including the keys', async () => {
    const refused = new RazorpayGateway(
      CONFIG,
      fakeFetch(() => json({ error: { code: 'BAD_REQUEST_ERROR' } }, 400)).fetch,
    );
    const error = await refused.cancelAtPeriodEnd('sub_1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as Error).message).toBe(
      'Razorpay answered 400 (BAD_REQUEST_ERROR) to POST /subscriptions/sub_1/cancel',
    );
    expect(JSON.stringify(error)).not.toContain('key-secret-value');

    const opaque = new RazorpayGateway(
      CONFIG,
      fakeFetch(() => new Response('<html>', { status: 502 })).fetch,
    );
    await expect(opaque.fetchSubscription('sub_1')).rejects.toThrow(
      'Razorpay answered 502 (no code) to GET /subscriptions/sub_1',
    );
    const down = new RazorpayGateway(
      CONFIG,
      fakeFetch(() => Promise.reject(new Error('connect ECONNREFUSED key-secret-value'))).fetch,
    );
    await expect(down.fetchSubscription('sub_1')).rejects.toThrow(
      'Razorpay could not be reached (GET /subscriptions/sub_1)',
    );
    const noLink = new RazorpayGateway(CONFIG, fakeFetch(() => json({ id: 'sub_2' })).fetch);
    await expect(
      noLink.createSubscription({
        checkoutId: 'c',
        organizationId: 'o',
        plan: 'starter',
        interval: 'monthly',
        quantity: 1,
        totalPaise: 1,
      }),
    ).rejects.toThrow('Razorpay gave no payment link');
  });
});

describe('RazorpayGateway webhooks', () => {
  const gateway = new RazorpayGateway(CONFIG, fakeFetch(() => json({})).fetch);
  const signed = (body: object, headers: Record<string, string> = {}) => {
    const raw = Buffer.from(JSON.stringify(body));
    return gateway.verifyWebhook(raw, {
      'x-razorpay-signature': hmacHex('webhook-secret-value', raw),
      ...headers,
    });
  };
  const subscription = {
    id: 'sub_1',
    status: 'active',
    current_start: 1_790_000_000,
    current_end: 1_792_592_000,
  };

  it('trusts only a body signed with the webhook secret', () => {
    const raw = Buffer.from('{"event":"subscription.charged"}');
    expect(gateway.verifyWebhook(raw, {})).toBeNull();
    expect(
      gateway.verifyWebhook(raw, { 'x-razorpay-signature': hmacHex('other', raw) }),
    ).toBeNull();
    expect(gateway.verifyWebhook(raw, { 'x-razorpay-signature': 'short' })).toBeNull();
  });

  it('translates a charge with its payment and paid period, named by the event id header', () => {
    expect(
      signed(
        {
          event: 'subscription.charged',
          created_at: 1_790_000_100,
          payload: {
            subscription: { entity: subscription },
            payment: { entity: { id: 'pay_1', amount: 1_768_82 } },
          },
        },
        { 'x-razorpay-event-id': 'evt_1' },
      ),
    ).toEqual({
      id: 'evt_1',
      type: 'charged',
      gatewayType: 'subscription.charged',
      gatewaySubscriptionId: 'sub_1',
      paymentId: 'pay_1',
      amountPaise: 1_768_82,
      periodStart: new Date(1_790_000_000_000),
      periodEnd: new Date(1_792_592_000_000),
    });
  });

  it('maps the subscription events it acts on and ignores the rest', () => {
    const typeOf = (event: string) =>
      signed({ event, created_at: 1, payload: { subscription: { entity: subscription } } })?.type;
    expect(
      [
        'subscription.activated',
        'subscription.pending',
        'subscription.halted',
        'subscription.cancelled',
        'subscription.completed',
        'subscription.authenticated',
      ].map(typeOf),
    ).toEqual([
      'activated',
      'payment_failed',
      'payment_failed',
      'cancelled',
      'cancelled',
      'ignored',
    ]);
    // Without an event id header, the event is named by what it is about.
    expect(
      signed(
        { event: 'payment.captured', created_at: 7, payload: {} },
        { 'x-razorpay-event-id': '' },
      ),
    ).toMatchObject({
      id: 'payment.captured::7',
      type: 'ignored',
      gatewaySubscriptionId: null,
      paymentId: null,
      amountPaise: null,
      periodStart: null,
      periodEnd: null,
    });
  });
});

describe('signatureMatches', () => {
  it('compares HMACs in constant time and refuses anything but a string', () => {
    const body = Buffer.from('{}');
    expect(signatureMatches('s', body, hmacHex('s', body))).toBe(true);
    expect(signatureMatches('s', body, ['x'])).toBe(false);
  });
});
