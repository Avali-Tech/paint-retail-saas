import { migrateDatabase } from '@paint/db';
import type { PlanChangeResult, SubscriptionInvoiceView, SubscriptionView } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { api, ok } from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import { hmacHex } from '../payments-gateway/signatures.js';

// The API with the Razorpay adapter, end to end, against a stand-in for Razorpay's
// API (global fetch is replaced before the app is built): no network.
const WEBHOOK_SECRET = 'razorpay-webhook-secret-for-tests';
const PLAN_IDS = {
  starter_monthly: 'plan_SM',
  starter_annual: 'plan_SA',
  standard_monthly: 'plan_GM',
  standard_annual: 'plan_GA',
  enterprise_monthly: 'plan_EM',
  enterprise_annual: 'plan_EA',
};

let database: TestDatabase;
let t: TestApp;
let owner: string;
const sent: { method: string; url: string; body: unknown }[] = [];

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const call = {
      method: String(init?.method),
      url: input as string,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    sent.push(call);
    const created = call.method === 'POST' && call.url.endsWith('/subscriptions');
    return Promise.resolve(
      Response.json(
        created ? { id: 'sub_RZP1', status: 'created', short_url: 'https://rzp.io/i/pay1' } : {},
      ),
    );
  });
  t = await startTestApp(database.connectionString, {
    SIGNUP_PLAN: 'trial',
    PAYMENT_GATEWAY: 'razorpay',
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: 'razorpay-key-secret',
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RAZORPAY_PLAN_IDS: JSON.stringify(PLAN_IDS),
  });
  owner = ok(
    await t.app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        organizationName: 'Razorpay Paints',
        fullName: 'Razorpay Owner',
        phone: uniquePhone(),
        password: 'Owner@2026',
      },
    }),
  ).json<{ token: string }>().token;
}, 180_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await t.close();
  await database.stop();
});

/** A webhook as Razorpay sends it, signed with the webhook secret. */
function razorpayWebhook(event: string, payload: object, eventId?: string) {
  const body = Buffer.from(JSON.stringify({ entity: 'event', event, created_at: 1, payload }));
  return t.app.inject({
    method: 'POST',
    url: '/subscription/webhooks',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': hmacHex(WEBHOOK_SECRET, body),
      ...(eventId ? { 'x-razorpay-event-id': eventId } : {}),
    },
    payload: body,
  });
}

describe('subscribing through Razorpay', () => {
  it('pays on Razorpay’s page, and its signed webhooks move the plan and the period', async () => {
    const o = api(t, owner);
    const started = ok(
      await o.post('/subscription/change', { plan: 'starter', interval: 'monthly' }),
    ).json<PlanChangeResult>();
    expect(started).toMatchObject({
      kind: 'checkout',
      checkout: { gateway: 'razorpay', checkoutUrl: 'https://rzp.io/i/pay1', totalPaise: 942_82 },
    });
    expect(sent.at(-1)).toMatchObject({
      method: 'POST',
      url: 'https://api.razorpay.com/v1/subscriptions',
      body: { plan_id: 'plan_SM', quantity: 1, total_count: 120 },
    });
    // The fake gateway's page does not exist here.
    if (started.kind !== 'checkout') return;
    expect(
      (await o.post(`/subscription/checkouts/${started.checkout.id}/fake-pay`)).statusCode,
    ).toBe(404);

    const [clock] = (
      await t.connection.db.execute<{ now: number }>(
        sql`select extract(epoch from now())::int as now`,
      )
    ).rows as [{ now: number }];
    const entity = {
      id: 'sub_RZP1',
      status: 'active',
      current_start: clock.now - 60,
      current_end: clock.now + 30 * 86_400,
    };
    const activated = await razorpayWebhook(
      'subscription.activated',
      { subscription: { entity } },
      'evt_A',
    );
    expect(ok(activated).json()).toEqual({ received: 'applied' });
    const charged = await razorpayWebhook('subscription.charged', {
      subscription: { entity },
      payment: { entity: { id: 'pay_RZP1', amount: 942_82 } },
    });
    expect(ok(charged).json()).toEqual({ received: 'applied' });
    const billing = ok(await o.get('/subscription')).json<SubscriptionView>();
    expect(billing).toMatchObject({
      plan: 'starter',
      status: 'active',
      gateway: 'razorpay',
      currentPeriodEnd: new Date(entity.current_end * 1000).toISOString(),
    });
    const [invoice] = ok(await o.get('/subscription/invoices')).json<SubscriptionInvoiceView[]>();
    expect(invoice).toMatchObject({ totalPaise: 942_82, plan: 'starter' });

    const forged = Buffer.from('{"event":"subscription.charged","payload":{}}');
    const refused = await t.app.inject({
      method: 'POST',
      url: '/subscription/webhooks',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'nope' },
      payload: forged,
    });
    expect(refused.statusCode).toBe(400);

    ok(await o.post('/subscription/change', { plan: 'standard', interval: 'annual' }));
    expect(sent.at(-1)).toMatchObject({
      method: 'PATCH',
      url: 'https://api.razorpay.com/v1/subscriptions/sub_RZP1',
      body: { plan_id: 'plan_GA', schedule_change_at: 'cycle_end' },
    });
    ok(await o.post('/subscription/cancel'));
    expect(sent.at(-1)).toMatchObject({
      method: 'POST',
      url: 'https://api.razorpay.com/v1/subscriptions/sub_RZP1/cancel',
    });
    // An event about no subscription changes nothing.
    const orphan = await razorpayWebhook('subscription.charged', {
      payment: { entity: { id: 'pay_RZP2', amount: 1 } },
    });
    expect(ok(orphan).json()).toEqual({ received: 'ignored' });
    const halted = await razorpayWebhook('subscription.halted', { subscription: { entity } });
    expect(ok(halted).json()).toEqual({ received: 'applied' });
    expect(ok(await o.get('/subscription/status')).json()).toMatchObject({ status: 'past_due' });
  });
});
