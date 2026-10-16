import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayError } from '../payments-gateway/payment-gateway.js';
import {
  RAZORPAY_MIN_EXPIRY_MS,
  RazorpayPaymentLinkProvider,
  type RazorpayCredentials,
} from './razorpay-payment-links.js';

// Recorded answers in the shape of Razorpay's documented samples
// (https://razorpay.com/docs/api/payments/payment-links/, /api/refunds/,
// /webhooks/payloads/payment-links/, /webhooks/payloads/refunds/). No network.

const API = 'https://api.razorpay.test/v1';
const LIVE: RazorpayCredentials = {
  keyId: 'rzp_live_ILgsfZCZoFIKMb',
  keySecret: 'liveKeySecretABCDEFGH1234',
  webhookSecret: 'shop-webhook-secret',
};
const TEST: RazorpayCredentials = { ...LIVE, keyId: 'rzp_test_1DP5mmOlF5G5ag' };
const NOW = new Date('2026-10-16T06:00:00Z');

interface Call {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

type Answer = { status: number; body: unknown } | 'network';

/** A fetch that records each request and gives the next recorded answer. */
function recorder(...answers: Answer[]) {
  const calls: Call[] = [];
  const fetch = ((input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      method: String(init?.method),
      url: input,
      authorization: headers.get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`No answer recorded for ${input}`);
    if (answer === 'network') return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(
      new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const slept: number[] = [];
function provider(credentials: RazorpayCredentials, fetch: typeof globalThis.fetch) {
  return new RazorpayPaymentLinkProvider(credentials, {
    apiUrl: API,
    fetch,
    now: () => NOW,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });
}

const LINK = {
  id: 'plink_ExjpAUN3gVHrPJ',
  short_url: 'https://rzp.io/i/nxrHnLJ',
  status: 'created',
  upi_link: true,
};
const REQUEST = {
  reference: 'PL-000007',
  amountPaise: 118_000,
  description: 'Rangoli Paints: Invoice AMP/26-27/000001',
  expiresAt: new Date(NOW.getTime() + 10 * 60_000),
  customer: { name: 'Ravi Kumar', mobile: '+91 98111 00032' },
};
const BAD_REQUEST = (description: string) => ({
  status: 400,
  body: { error: { code: 'BAD_REQUEST_ERROR', description } },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RazorpayPaymentLinkProvider: links', () => {
  it('makes a UPI link with live keys, Basic auth, our reference and at least 16 minutes', async () => {
    const http = recorder({ status: 200, body: { ...LINK, reference_id: 'PL-000007-x' } });
    const created = await provider(LIVE, http.fetch).createPayment(REQUEST);
    // Recorded with the expiry Razorpay keeps ([PO-60]).
    expect(created).toEqual({
      gatewayReference: LINK.id,
      url: LINK.short_url,
      expiresAt: new Date(NOW.getTime() + RAZORPAY_MIN_EXPIRY_MS),
    });
    const [call] = http.calls;
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${API}/payment_links`);
    expect(call?.authorization).toBe(
      `Basic ${Buffer.from(`${LIVE.keyId}:${LIVE.keySecret}`).toString('base64')}`,
    );
    const body = call?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      amount: 118_000,
      currency: 'INR',
      accept_partial: false,
      description: REQUEST.description,
      // Razorpay refuses less than 15 minutes: our 10 become 16 at the gateway.
      expire_by: (NOW.getTime() + RAZORPAY_MIN_EXPIRY_MS) / 1000,
      customer: { name: 'Ravi Kumar', contact: '+919811100032' },
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { reference: 'PL-000007' },
      upi_link: true,
    });
    expect(body.reference_id).toMatch(/^PL-000007-[0-9a-f]{12}$/);
    expect(String(body.reference_id).length).toBeLessThanOrEqual(40);
    expect(body).not.toHaveProperty('options');
  });

  it('keeps a longer expiry, and with test keys offers UPI on a standard link', async () => {
    const later = new Date(NOW.getTime() + 2 * 60 * 60_000);
    const http = recorder({ status: 200, body: { ...LINK, expire_by: later.getTime() / 1000 } });
    const test = provider(TEST, http.fetch);
    expect(test.live).toBe(false);
    const created = await test.createPayment({
      ...REQUEST,
      expiresAt: later,
      customer: { name: 'R', mobile: '12' },
    });
    expect(created.expiresAt).toEqual(later);
    const body = http.calls[0]?.body as Record<string, unknown>;
    expect(body.expire_by).toBe(later.getTime() / 1000);
    expect(body).not.toHaveProperty('upi_link');
    expect(body.options).toEqual({
      checkout: { method: { upi: '1', card: '0', netbanking: '0', wallet: '0' } },
    });
    // A number Razorpay would refuse is left out.
    expect(body.customer).toEqual({ name: 'R' });
  });

  it('sends no customer and the earliest expiry when there is neither', async () => {
    const http = recorder({ status: 200, body: LINK });
    await provider(LIVE, http.fetch).createPayment({
      ...REQUEST,
      expiresAt: null,
      customer: null,
    });
    const body = http.calls[0]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('customer');
    expect(body.expire_by).toBe((NOW.getTime() + RAZORPAY_MIN_EXPIRY_MS) / 1000);
    // A link Razorpay says never expires (expire_by 0) is recorded with what was asked.
    const forever = await provider(
      LIVE,
      recorder({ status: 200, body: { ...LINK, expire_by: 0 } }).fetch,
    ).createPayment({
      ...REQUEST,
      customer: { name: 'Ravi', mobile: null },
    });
    expect(forever.expiresAt).toEqual(new Date(NOW.getTime() + RAZORPAY_MIN_EXPIRY_MS));
  });

  it('tries again after a timeout or a 5xx, and finds a link a lost answer had made', async () => {
    slept.length = 0;
    const http = recorder(
      'network',
      { status: 502, body: 'Bad gateway' },
      BAD_REQUEST('reference_id already exists'),
      { status: 200, body: { payment_links: [{ ...LINK, reference_id: 'other' }] } },
    );
    // The lookup finds only another link: the refusal stands.
    await expect(provider(LIVE, http.fetch).createPayment(REQUEST)).rejects.toMatchObject({
      code: 'BAD_REQUEST_ERROR',
    });
    expect(slept).toEqual([250, 1_000]);
    const sent = (http.calls[0]?.body as { reference_id: string }).reference_id;
    // Every try sends the same reference, so a retry finds the first try's link.
    expect(
      http.calls.slice(0, 3).map((call) => (call.body as { reference_id: string }).reference_id),
    ).toEqual([sent, sent, sent]);
    expect(http.calls[3]?.url).toBe(
      `${API}/payment_links?reference_id=${encodeURIComponent(sent)}`,
    );

    const found = recorder('network', BAD_REQUEST('reference_id already exists'), {
      status: 200,
      body: { payment_links: [] },
    });
    // Answers are given in order; capture the reference to answer the lookup with it.
    const lookup = recorder('network', BAD_REQUEST('reference_id already exists'));
    const real = provider(LIVE, (input, init) => {
      if (lookup.calls.length < 2) return lookup.fetch(input, init);
      const sent = lookup.calls[0]?.body as { reference_id: string };
      const reference = sent.reference_id;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            payment_links: [{ ...LINK, id: 'plink_found', reference_id: reference }],
          }),
          { status: 200 },
        ),
      );
    });
    await expect(real.createPayment(REQUEST)).resolves.toEqual({
      gatewayReference: 'plink_found',
      url: LINK.short_url,
      expiresAt: new Date(NOW.getTime() + RAZORPAY_MIN_EXPIRY_MS),
    });
    await expect(provider(LIVE, found.fetch).createPayment(REQUEST)).rejects.toBeInstanceOf(
      GatewayError,
    );
  });

  it('gives up after three tries, and never retries a refusal', async () => {
    const down = recorder('network', 'network', 'network');
    await expect(provider(LIVE, down.fetch).createPayment(REQUEST)).rejects.toMatchObject({
      code: 'unreachable',
      retryable: true,
      message: 'Razorpay could not be reached (POST /payment_links)',
    });
    expect(down.calls).toHaveLength(3);
    const refused = recorder({ status: 401, body: { error: { code: 'BAD_REQUEST_ERROR' } } });
    await expect(provider(LIVE, refused.fetch).createPayment(REQUEST)).rejects.toMatchObject({
      code: 'unauthorized',
      retryable: false,
    });
    expect(refused.calls).toHaveLength(1);
    const busy = recorder({ status: 429, body: {} }, { status: 200, body: LINK });
    await expect(provider(LIVE, busy.fetch).createPayment(REQUEST)).resolves.toMatchObject({
      gatewayReference: LINK.id,
    });
  });

  it('uses the global fetch, the clock and real waits by default', async () => {
    const http = recorder('network', { status: 200, body: LINK });
    vi.stubGlobal('fetch', http.fetch);
    const plain = new RazorpayPaymentLinkProvider(LIVE, { apiUrl: API });
    await expect(plain.createPayment({ ...REQUEST, expiresAt: null })).resolves.toMatchObject({
      gatewayReference: LINK.id,
    });
    const expireBy = (http.calls[1]?.body as { expire_by: number }).expire_by * 1000;
    expect(Math.abs(expireBy - Date.now() - RAZORPAY_MIN_EXPIRY_MS)).toBeLessThan(60_000);
  });

  it('cancels a link', async () => {
    const http = recorder({ status: 200, body: { ...LINK, status: 'cancelled' } });
    await provider(LIVE, http.fetch).cancelPayment('plink_ExjpAUN3gVHrPJ');
    expect(http.calls[0]).toMatchObject({
      method: 'POST',
      url: `${API}/payment_links/plink_ExjpAUN3gVHrPJ/cancel`,
      body: undefined,
    });
  });

  it('proves the keys with a harmless read', async () => {
    const http = recorder({ status: 200, body: { entity: 'collection', count: 0, items: [] } });
    await provider(LIVE, http.fetch).testConnection();
    expect(http.calls[0]).toMatchObject({ method: 'GET', url: `${API}/payments?count=1` });
  });

  it('never puts a key in an error', async () => {
    const http = recorder(
      { status: 500, body: 'oops' },
      { status: 500, body: 'oops' },
      {
        status: 500,
        body: 'oops',
      },
    );
    const error = await provider(LIVE, http.fetch)
      .testConnection()
      .then(
        () => new GatewayError('expected a failure'),
        (caught: unknown) => caught as GatewayError,
      );
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.message).toBe('Razorpay answered 500 (http_500) to GET /payments');
    const text = JSON.stringify({
      code: error.code,
      retryable: error.retryable,
      message: error.message,
      stack: error.stack,
    });
    for (const secret of [LIVE.keySecret, LIVE.webhookSecret, LIVE.keyId]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('RazorpayPaymentLinkProvider: refunds', () => {
  const REFUND = {
    gatewayPaymentId: 'pay_29QQoUBi66xm2f',
    amountPaise: 6_400,
    receipt: '5f8f5d40-8f5a-4d9b-a2a3-7a0c2d1e9f10',
    notes: { link: 'PL-000007' },
  };

  it('refunds a payment at normal speed with our receipt', async () => {
    const http = recorder({
      status: 200,
      body: {
        id: 'rfnd_FP8QHiV938haTz',
        entity: 'refund',
        status: 'processed',
        receipt: REFUND.receipt,
      },
    });
    await expect(provider(LIVE, http.fetch).refundPayment(REFUND)).resolves.toEqual({
      gatewayRefundId: 'rfnd_FP8QHiV938haTz',
      status: 'processed',
    });
    expect(http.calls[0]).toMatchObject({
      method: 'POST',
      url: `${API}/payments/pay_29QQoUBi66xm2f/refund`,
      body: {
        amount: 6_400,
        speed: 'normal',
        receipt: REFUND.receipt,
        notes: { link: 'PL-000007' },
      },
    });
  });

  it('finds the refund already made with the receipt instead of refunding twice', async () => {
    const http = recorder(BAD_REQUEST('Duplicate receipt found for this refund request.'), {
      status: 200,
      body: {
        items: [
          { id: 'rfnd_other', status: 'processed', receipt: 'another' },
          { id: 'rfnd_FP8QHiV938haTz', status: 'pending', receipt: REFUND.receipt },
        ],
      },
    });
    await expect(provider(LIVE, http.fetch).refundPayment(REFUND)).resolves.toEqual({
      gatewayRefundId: 'rfnd_FP8QHiV938haTz',
      status: 'pending',
    });
    expect(http.calls[1]?.url).toBe(`${API}/payments/pay_29QQoUBi66xm2f/refunds?count=100`);
  });

  it('passes on a refusal it cannot explain by the receipt, and other failures as they are', async () => {
    const refused = recorder(
      BAD_REQUEST('Your account does not have enough balance to carry out the refund operation.'),
      { status: 200, body: {} },
    );
    await expect(provider(LIVE, refused.fetch).refundPayment(REFUND)).rejects.toMatchObject({
      code: 'BAD_REQUEST_ERROR',
      retryable: false,
    });
    const unauthorized = recorder({ status: 401, body: {} });
    await expect(provider(LIVE, unauthorized.fetch).refundPayment(REFUND)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});

describe('RazorpayPaymentLinkProvider: webhooks', () => {
  /** Razorpay's documented scheme: hex HMAC-SHA256 of the raw body with the webhook secret. */
  const sign = (raw: Buffer, secret = LIVE.webhookSecret) =>
    createHmac('sha256', secret).update(raw).digest('hex');
  const deliver = (body: unknown, headers: Record<string, unknown> = {}) => {
    const raw = Buffer.from(JSON.stringify(body));
    return provider(LIVE, recorder().fetch).verifyWebhook(raw, {
      'x-razorpay-signature': sign(raw),
      'x-razorpay-event-id': 'evt_Kq1',
      ...headers,
    });
  };
  const PAID = {
    entity: 'event',
    account_id: 'acc_BFQ7uQEaa7j2z7',
    event: 'payment_link.paid',
    contains: ['payment_link', 'order', 'payment'],
    created_at: 1_792_130_000,
    payload: {
      payment_link: { entity: { id: 'plink_ExjpAUN3gVHrPJ', amount: 118_000, status: 'paid' } },
      payment: {
        entity: {
          id: 'pay_29QQoUBi66xm2f',
          amount: 118_000,
          status: 'captured',
          method: 'upi',
          created_at: 1_792_129_990,
        },
      },
      order: { entity: { id: 'order_x', status: 'paid' } },
    },
  };

  it('believes a paid link signed with the shop’s secret, and nothing else', () => {
    expect(deliver(PAID)).toEqual({
      id: 'evt_Kq1',
      gatewayType: 'payment_link.paid',
      kind: 'paid',
      gatewayLinkId: 'plink_ExjpAUN3gVHrPJ',
      payment: {
        id: 'pay_29QQoUBi66xm2f',
        amountPaise: 118_000,
        paidAt: new Date(1_792_129_990_000),
      },
      refund: null,
    });
    const raw = Buffer.from(JSON.stringify(PAID));
    const shop = provider(LIVE, recorder().fetch);
    expect(
      shop.verifyWebhook(raw, { 'x-razorpay-signature': sign(raw, 'another-shop') }),
    ).toBeNull();
    expect(shop.verifyWebhook(raw, {})).toBeNull();
    // A body changed after signing.
    const changed = Buffer.from(JSON.stringify({ ...PAID, created_at: 1 }));
    expect(shop.verifyWebhook(changed, { 'x-razorpay-signature': sign(raw) })).toBeNull();
    // Signed but not JSON.
    const text = Buffer.from('not json');
    expect(shop.verifyWebhook(text, { 'x-razorpay-signature': sign(text) })).toBeNull();
  });

  it('names an event by its content when the event id header is missing', () => {
    expect(deliver(PAID, { 'x-razorpay-event-id': '' })?.id).toBe(
      'payment_link.paid:plink_ExjpAUN3gVHrPJ:pay_29QQoUBi66xm2f',
    );
    const expired = {
      event: 'payment_link.expired',
      created_at: 1_792_131_000,
      payload: { payment_link: { entity: { id: 'plink_A' } } },
    };
    expect(deliver(expired, { 'x-razorpay-event-id': undefined })?.id).toBe(
      'payment_link.expired:plink_A:1792131000',
    );
    const refunded = {
      event: 'refund.processed',
      created_at: 1_792_131_000,
      payload: { refund: { entity: { id: 'rfnd_A', payment_id: 'pay_A', amount: 100 } } },
    };
    expect(deliver(refunded, { 'x-razorpay-event-id': undefined })?.id).toBe(
      'refund.processed:rfnd_A:1792131000',
    );
  });

  it('translates expiry, cancellation, part payments, refunds and news it ignores', () => {
    const link = (event: string) => ({
      event,
      created_at: 1,
      payload: { payment_link: { entity: { id: 'plink_A' } } },
    });
    expect(deliver(link('payment_link.expired'))).toMatchObject({
      kind: 'expired',
      gatewayLinkId: 'plink_A',
    });
    expect(deliver(link('payment_link.cancelled'))).toMatchObject({ kind: 'cancelled' });
    expect(deliver({ ...PAID, event: 'payment_link.partially_paid' })).toMatchObject({
      kind: 'paid',
    });
    // A paid event without its payment says nothing to act on.
    expect(deliver(link('payment_link.paid'))).toMatchObject({
      kind: 'ignored',
      gatewayLinkId: 'plink_A',
    });
    const refund = (event: string) => ({
      event,
      created_at: 1,
      payload: {
        refund: {
          entity: {
            id: 'rfnd_FP8QHiV938haTz',
            payment_id: 'pay_29QQoUBi66xm2f',
            amount: 6_400,
            status: 'processed',
          },
        },
        payment: { entity: { id: 'pay_29QQoUBi66xm2f', amount: 118_000, created_at: 1 } },
      },
    });
    expect(deliver(refund('refund.processed'))).toEqual({
      id: 'evt_Kq1',
      gatewayType: 'refund.processed',
      kind: 'refund_processed',
      gatewayLinkId: null,
      payment: null,
      refund: { id: 'rfnd_FP8QHiV938haTz', paymentId: 'pay_29QQoUBi66xm2f', amountPaise: 6_400 },
    });
    expect(deliver(refund('refund.failed'))).toMatchObject({ kind: 'refund_failed' });
    expect(deliver(refund('refund.created'))).toMatchObject({
      kind: 'ignored',
      gatewayLinkId: null,
    });
    expect(deliver({ event: 'payment.captured', created_at: 1 })).toMatchObject({
      kind: 'ignored',
      gatewayLinkId: null,
    });
  });
});
