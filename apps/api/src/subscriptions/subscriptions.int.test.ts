import { migrateDatabase, schema, withTenant } from '@paint/db';
import {
  financialYear,
  gstinCheckCharacter,
  type CheckoutView,
  type PlanChangeResult,
  type SubscriptionInvoiceView,
  type SubscriptionStatusView,
  type SubscriptionView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { TenantDetail } from '../platform/tenants.service.js';
import { api, dbToday, ok } from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import { FakeGateway } from './fake-gateway.js';
import { SUBSCRIPTION_GATEWAY } from './subscription-gateway.js';

const { organizations, subscriptionInvoices, subscriptionPlanChanges, subscriptions } = schema;
const BOOTSTRAP_TOKEN = 'platform-bootstrap-token-for-subscription-tests';

let database: TestDatabase;
let t: TestApp;
let fake: FakeGateway;
let operator: string;
let fy: string;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString, {
    SIGNUP_PLAN: 'trial',
    SUBSCRIPTION_GATEWAY: 'fake',
    PLATFORM_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    PLATFORM_INVOICE_PREFIX: 'PRS',
  });
  fake = t.app.get<FakeGateway>(SUBSCRIPTION_GATEWAY);
  operator = ok(
    await t.app.inject({
      method: 'POST',
      url: '/platform/bootstrap',
      payload: {
        token: BOOTSTRAP_TOKEN,
        fullName: 'Meera Ops',
        email: 'meera@platform.example',
        password: 'Platform@2026',
      },
    }),
  ).json<{ token: string }>().token;
  fy = financialYear(await dbToday(t));
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

const gstin = (state: string) => {
  const first14 = `${state}AABCT1332L1Z`;
  return `${first14}${gstinCheckCharacter(first14)}`;
};

interface Shop {
  readonly id: string;
  readonly owner: string;
  /** A branch manager with every store: a member who is not the owner. */
  readonly member: string;
  readonly stores: string[];
}

/** A business that signed itself up (on the trial), with `stores` stores, optionally GST-registered. */
async function shop(name: string, stores = 2, registeredIn: string | null = '36'): Promise<Shop> {
  const signup = ok(
    await t.app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        organizationName: name,
        fullName: `${name} Owner`,
        phone: uniquePhone(),
        password: 'Owner@2026',
      },
    }),
  ).json<{ token: string; organizationId: string }>();
  const o = api(t, signup.token);
  const ids: string[] = [];
  for (let index = 0; index < stores; index++) {
    ids.push(
      ok(
        await o.post('/stores', { name: `Store ${String(index)}`, code: `S${String(index)}` }),
      ).json<{
        id: string;
      }>().id,
    );
  }
  if (registeredIn !== null) {
    ok(
      await o.put(`/gst-registrations/stores/${String(ids[0])}`, {
        registrationType: 'regular',
        stateCode: registeredIn,
        gstin: gstin(registeredIn),
        legalName: `${name} Private Limited`,
        addressLine: '1-2-3 Main Road',
        city: 'Somewhere',
        pincode: '500016',
      }),
    );
  }
  const roles = ok(await o.get('/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  ok(
    await o.post('/members', {
      fullName: `${name} Manager`,
      phone,
      password: 'Admin@2026',
      roleId: roles.find((role) => role.key === 'branch_manager')?.id,
      allStores: true,
    }),
  );
  const member = ok(
    await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { identifier: phone, password: 'Admin@2026' },
    }),
  ).json<{ token: string }>().token;
  return { id: signup.organizationId, owner: signup.token, member, stores: ids };
}

const view = async (s: Shop) =>
  ok(await api(t, s.owner).get('/subscription')).json<SubscriptionView>();
const status = async (token: string) =>
  ok(await api(t, token).get('/subscription/status')).json<SubscriptionStatusView>();
const change = (s: Shop, plan: string, interval = 'monthly') =>
  api(t, s.owner).post('/subscription/change', { plan, interval });
const invoices = async (s: Shop) =>
  ok(await api(t, s.owner).get('/subscription/invoices')).json<SubscriptionInvoiceView[]>();
const webhook = (body: Buffer, headers: Record<string, string>) =>
  t.app.inject({
    method: 'POST',
    url: '/subscription/webhooks',
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
  });
/** Moves a stored moment of a subscription by `days` (database clock only). */
const shift = (
  s: Shop,
  column: 'trial_ends_at' | 'current_period_end' | 'past_due_since',
  days: number,
) =>
  t.connection.db.execute(
    column === 'current_period_end'
      ? sql`update subscriptions set current_period_start = now() + make_interval(days => ${days - 30}),
          current_period_end = now() + make_interval(days => ${days}) where organization_id = ${s.id}`
      : sql`update subscriptions set ${sql.raw(column)} = now() + make_interval(days => ${days}) where organization_id = ${s.id}`,
  );

/** Upgrades through the fake checkout, as the owner would; answers the checkout. */
async function pay(s: Shop, plan = 'standard', interval = 'monthly'): Promise<CheckoutView> {
  const started = ok(await change(s, plan, interval)).json<PlanChangeResult>();
  if (started.kind !== 'checkout') throw new Error('Expected a checkout');
  return ok(
    await api(t, s.owner).post(`/subscription/checkouts/${started.checkout.id}/fake-pay`),
  ).json<CheckoutView>();
}

describe('the trial', () => {
  it('starts every self sign-up on a trial that every member can see', async () => {
    const s = await shop('Trial Paints');
    expect(await status(s.member)).toEqual({
      plan: 'trial',
      status: 'trialing',
      readOnly: false,
      trialEndsAt: expect.any(String),
      trialDaysLeft: 14,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      graceEndsAt: null,
    });
    const billing = await view(s);
    expect(billing).toMatchObject({
      planName: 'Trial',
      limits: { maxStores: 5, maxMembers: 25 },
      usage: { stores: 2, members: 2 },
      interval: null,
      gateway: null,
      history: [{ fromPlan: null, toPlan: 'trial', source: 'signup', changedBy: null }],
    });
    expect(billing.offers.map((offer) => [offer.plan, offer.blockers])).toEqual([
      ['starter', [{ what: 'stores', used: 2, limit: 1 }]],
      ['standard', []],
      ['enterprise', []],
    ]);
    expect(billing.offers[1]?.charges.monthly).toEqual({
      quantity: 2,
      unitPricePaise: 1_499_00,
      taxablePaise: 2_998_00,
      gstPaise: 539_64,
      totalPaise: 3_537_64,
    });
  });

  it('is managed by the owner only', async () => {
    const s = await shop('Owners Only Paints', 1);
    for (const reply of [
      await api(t, s.member).get('/subscription'),
      await api(t, s.member).post('/subscription/change', {
        plan: 'standard',
        interval: 'monthly',
      }),
      await api(t, s.member).post('/subscription/cancel'),
      await api(t, s.member).get('/subscription/invoices'),
    ]) {
      expect([reply.statusCode, reply.json<{ message: string }>().message]).toEqual([
        403,
        'Only the owner of the business can manage its subscription',
      ]);
    }
    expect((await change(s, 'trial')).statusCode).toBe(400);
    expect((await change(s, 'standard', 'weekly')).statusCode).toBe(400);
  });

  it('refuses a plan smaller than what the business uses, saying why', async () => {
    const s = await shop('Too Big Paints', 2);
    const refused = await change(s, 'starter');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      statusCode: 409,
      code: 'plan_limits_exceeded',
      message:
        'The Starter plan allows 1 active store and you have 2. Close stores or deactivate team members first.',
      blockers: [{ what: 'stores', used: 2, limit: 1 }],
    });
  });
});

describe('upgrading through the gateway', () => {
  it('lets a trial business upgrade to a paid plan by itself, with our GST invoice', async () => {
    const s = await shop('Upgrade Paints', 2);
    const started = ok(await change(s, 'standard')).json<PlanChangeResult>();
    if (started.kind !== 'checkout') throw new Error('Expected a checkout');
    expect(started.checkout).toEqual({
      id: expect.any(String),
      plan: 'standard',
      interval: 'monthly',
      quantity: 2,
      totalPaise: 3_537_64,
      gateway: 'fake',
      checkoutUrl: `http://localhost:5173/billing/checkout/${started.checkout.id}`,
      status: 'open',
      createdAt: expect.any(String),
    });
    // Nothing changes until the gateway reports the payment.
    expect((await view(s)).plan).toBe('trial');
    const url = `/subscription/checkouts/${started.checkout.id}`;
    expect(ok(await api(t, s.owner).get(url)).json<CheckoutView>().status).toBe('open');
    expect((await api(t, s.member).post(`${url}/fake-pay`)).statusCode).toBe(403);
    const other = await shop('Someone Else Paints', 1);
    expect((await api(t, other.owner).get(url)).statusCode).toBe(404);

    const paid = ok(await api(t, s.owner).post(`${url}/fake-pay`)).json<CheckoutView>();
    expect(paid.status).toBe('paid');
    expect((await api(t, s.owner).post(`${url}/fake-pay`)).statusCode).toBe(409);

    const billing = await view(s);
    expect(billing).toMatchObject({
      plan: 'standard',
      status: 'active',
      readOnly: false,
      trialEndsAt: null,
      trialDaysLeft: null,
      interval: 'monthly',
      quantity: 2,
      gateway: 'fake',
      cancelAtPeriodEnd: false,
    });
    expect(
      billing.history.map((row) => [row.fromPlan, row.toPlan, row.source, row.changedBy]),
    ).toEqual([
      ['trial', 'standard', 'owner', 'Upgrade Paints Owner'],
      [null, 'trial', 'signup', null],
    ]);
    const [period] = (
      await t.connection.db.execute<{ days: number }>(
        sql`select extract(day from current_period_end - current_period_start)::int as days from subscriptions where organization_id = ${s.id}`,
      )
    ).rows;
    expect(period?.days).toBeGreaterThanOrEqual(28);

    const [invoice] = await invoices(s);
    expect(invoice).toEqual({
      id: expect.any(String),
      number: expect.stringMatching(new RegExp(`^PRS/${fy.slice(2)}/\\d{6}$`)) as string,
      issuedOn: await dbToday(t),
      plan: 'standard',
      interval: 'monthly',
      quantity: 2,
      periodStart: await dbToday(t),
      periodEnd: expect.any(String),
      taxablePaise: 2_998_00,
      taxPaise: 539_64,
      totalPaise: 3_537_64,
      // Paid at the gateway, so payable the day it was issued.
      dueOn: await dbToday(t),
      payment: {
        mode: 'online',
        amountPaise: 3_537_64,
        paidOn: await dbToday(t),
        reference: expect.stringMatching(/^pay_fake_/) as string,
      },
    });
  });

  it('numbers invoices gap-free in the platform series and taxes by state', async () => {
    const before = (
      await t.connection.db
        .select({ number: subscriptionInvoices.number })
        .from(subscriptionInvoices)
    ).length;
    const telangana = await shop('Intra Paints', 1, '36');
    const maharashtra = await shop('Inter Paints', 1, '27');
    const unregistered = await shop('Small Paints', 1, null);
    await pay(telangana, 'starter');
    await pay(maharashtra, 'starter');
    await pay(unregistered, 'starter', 'annual');
    const rows = await t.connection.db
      .select()
      .from(subscriptionInvoices)
      .where(sql`${subscriptionInvoices.serial} > ${before}`)
      .orderBy(subscriptionInvoices.serial);
    const digits = (serial: number) => String(serial).padStart(6, '0');
    expect(
      rows.map((row) => [
        row.number,
        row.placeOfSupply,
        row.cgstPaise,
        row.sgstPaise,
        row.igstPaise,
        row.totalPaise,
        row.buyer.gstin,
        row.sacCode,
      ]),
    ).toEqual([
      [
        `PRS/${fy.slice(2)}/${digits(before + 1)}`,
        '36',
        71_91,
        71_91,
        0,
        942_82,
        gstin('36'),
        '998315',
      ],
      [
        `PRS/${fy.slice(2)}/${digits(before + 2)}`,
        '27',
        0,
        0,
        143_82,
        942_82,
        gstin('27'),
        '998315',
      ],
      // Unregistered, no state given: billed in the platform's state.
      [
        `PRS/${fy.slice(2)}/${digits(before + 3)}`,
        '36',
        719_10,
        719_10,
        0,
        9_428_20,
        null,
        '998315',
      ],
    ]);
    expect(rows[0]?.supplier).toMatchObject({
      legalName: 'Paint Retail SaaS Private Limited (placeholder)',
      gstin: '36AAACP0000P1ZP',
      stateCode: '36',
    });
    expect(rows[0]?.buyer).toMatchObject({
      legalName: 'Intra Paints Private Limited',
      tradeName: 'Intra Paints',
      addressLines: ['1-2-3 Main Road'],
      stateCode: '36',
    });
    expect(rows[2]?.buyer).toMatchObject({
      legalName: 'Small Paints',
      tradeName: null,
      stateCode: null,
    });
    const [small] = await invoices(unregistered);
    const smallPdf = await api(t, unregistered.owner).get(
      `/subscription/invoices/${String(small?.id)}/pdf`,
    );
    expect(smallPdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const [mine] = await invoices(maharashtra);
    const pdf = await api(t, maharashtra.owner).get(
      `/subscription/invoices/${String(mine?.id)}/pdf`,
    );
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain(`PRS-${fy.slice(2)}-`);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // Another business's invoice is not found; a business cannot see another's.
    expect(
      (await api(t, telangana.owner).get(`/subscription/invoices/${String(mine?.id)}/pdf`))
        .statusCode,
    ).toBe(404);
    expect((await invoices(telangana)).map((row) => row.id)).not.toContain(mine?.id);
    // Issued invoices are permanent.
    await expect(
      t.connection.db
        .delete(subscriptionInvoices)
        .where(eq(subscriptionInvoices.id, String(mine?.id))),
    ).rejects.toThrow();
  });

  it('changes a running plan in place: limits now, the price from the next period', async () => {
    const s = await shop('Growing Paints', 2);
    await pay(s, 'standard');
    const before = (await invoices(s)).length;
    const result = ok(await change(s, 'enterprise', 'annual')).json<PlanChangeResult>();
    expect(result.kind).toBe('changed');
    if (result.kind !== 'changed') return;
    expect(result.subscription).toMatchObject({
      plan: 'enterprise',
      interval: 'annual',
      status: 'active',
    });
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'change',
      detail: { plan: 'enterprise', interval: 'annual', quantity: 2 },
    });
    expect(result.subscription.history[0]).toMatchObject({
      fromPlan: 'standard',
      toPlan: 'enterprise',
      interval: 'annual',
      source: 'owner',
    });
    expect((await invoices(s)).length).toBe(before);
    const again = await change(s, 'enterprise', 'annual');
    expect([again.statusCode, again.json<{ message: string }>().message]).toEqual([
      409,
      'The business is already on this plan',
    ]);
    // Plan history is permanent.
    await expect(
      t.connection.db
        .delete(subscriptionPlanChanges)
        .where(eq(subscriptionPlanChanges.organizationId, s.id)),
    ).rejects.toThrow();
  });
});

describe('webhooks', () => {
  it('believes nothing without a good signature and applies each event once', async () => {
    const s = await shop('Webhook Paints', 1);
    await pay(s);
    const subscriptionId = String(
      fake.calls.findLast((call) => call.method === 'create')?.subscriptionId,
    );
    const event = fake.webhook('charged', subscriptionId, { amountPaise: 1_768_82 });
    const forged = await webhook(event.body, { 'x-fake-gateway-signature': 'f'.repeat(64) });
    expect([forged.statusCode, forged.json<{ message: string }>().message]).toEqual([
      400,
      'Invalid signature',
    ]);
    expect((await webhook(event.body, {})).statusCode).toBe(400);
    const before = (await invoices(s)).length;
    expect(ok(await webhook(event.body, event.headers)).json()).toEqual({ received: 'applied' });
    expect(ok(await webhook(event.body, event.headers)).json()).toEqual({ received: 'duplicate' });
    expect((await invoices(s)).length).toBe(before + 1);

    const unknown = fake.webhook('charged', 'sub_fake_nobody', { amountPaise: 1 });
    expect(ok(await webhook(unknown.body, unknown.headers)).json()).toEqual({
      received: 'ignored',
    });
    const other = fake.webhook('ignored', subscriptionId);
    expect(ok(await webhook(other.body, other.headers)).json()).toEqual({ received: 'ignored' });
    // A payment the gateway reports for a different amount is still invoiced as priced, and logged.
    const odd = fake.webhook('charged', subscriptionId, { amountPaise: 1, id: 'pay_fake_odd' });
    expect(ok(await webhook(odd.body, odd.headers)).json()).toEqual({ received: 'applied' });
    // The same payment in another event, or a charge without a payment, invoices nothing more.
    const repeat = fake.webhook('charged', subscriptionId, { amountPaise: 1, id: 'pay_fake_odd' });
    ok(await webhook(repeat.body, repeat.headers));
    const bare = fake.webhook('charged', subscriptionId);
    expect(ok(await webhook(bare.body, bare.headers)).json()).toEqual({ received: 'applied' });
    expect((await invoices(s)).length).toBe(before + 2);
    const empty = await t.app.inject({ method: 'POST', url: '/subscription/webhooks' });
    expect(empty.statusCode).toBe(400);
  });

  it('a failed renewal leaves a grace period, then the business is read-only until it pays', async () => {
    const s = await shop('Late Paints', 1);
    await pay(s);
    const subscriptionId = String(
      fake.calls.findLast((call) => call.method === 'create')?.subscriptionId,
    );
    const failed = fake.webhook('payment_failed', subscriptionId);
    ok(await webhook(failed.body, failed.headers));
    const late = await status(s.member);
    expect(late).toMatchObject({
      status: 'past_due',
      readOnly: false,
      graceEndsAt: expect.any(String),
    });
    expect(
      (await api(t, s.owner).post('/stores', { name: 'Still OK', code: 'OK1' })).statusCode,
    ).toBe(201);

    await shift(s, 'past_due_since', -8);
    expect(await status(s.member)).toMatchObject({ status: 'past_due', readOnly: true });
    const refused = await api(t, s.owner).post('/stores', { name: 'Refused', code: 'NO1' });
    expect([refused.statusCode, refused.json()]).toEqual([
      403,
      {
        statusCode: 403,
        code: 'subscription_read_only',
        status: 'past_due',
        message:
          'Your subscription payment is overdue, so the business is read-only. The owner can pay under Billing.',
      },
    ]);
    // Reading, notices and the owner's billing still work.
    expect((await api(t, s.member).get('/stores')).statusCode).toBe(200);
    expect((await api(t, s.member).post('/notifications/read-all')).statusCode).toBeLessThan(300);
    expect((await api(t, s.owner).get('/subscription')).statusCode).toBe(200);

    const paid = fake.webhook('charged', subscriptionId, { amountPaise: 1_768_82 });
    ok(await webhook(paid.body, paid.headers));
    expect(await status(s.member)).toMatchObject({
      status: 'active',
      readOnly: false,
      graceEndsAt: null,
    });
    expect((await api(t, s.owner).post('/stores', { name: 'Back', code: 'BK1' })).statusCode).toBe(
      201,
    );
  });

  it('a paid period that ends without a renewal is past due from its end', async () => {
    const s = await shop('Lapsed Paints', 1);
    await pay(s);
    await shift(s, 'current_period_end', -1);
    expect(await status(s.owner)).toMatchObject({ status: 'past_due', readOnly: false });
  });
});

describe('cancelling', () => {
  it('runs to the end of the paid period, then the business is read-only until it subscribes again', async () => {
    const s = await shop('Leaving Paints', 1);
    const trialCancel = await api(t, s.owner).post('/subscription/cancel');
    expect(trialCancel.statusCode).toBe(409);
    await pay(s);
    const firstId = String(fake.calls.findLast((call) => call.method === 'create')?.subscriptionId);
    const cancelled = ok(
      await api(t, s.owner).post('/subscription/cancel'),
    ).json<SubscriptionView>();
    expect(cancelled).toMatchObject({ status: 'active', cancelAtPeriodEnd: true, readOnly: false });
    expect(fake.calls.at(-1)).toEqual({ method: 'cancel', subscriptionId: firstId });
    expect((await api(t, s.owner).post('/subscription/cancel')).statusCode).toBe(409);

    await shift(s, 'current_period_end', -1);
    expect(await status(s.member)).toMatchObject({ status: 'cancelled', readOnly: true });
    const ended = fake.webhook('cancelled', firstId);
    ok(await webhook(ended.body, ended.headers));
    const [row] = await t.connection.db
      .select({ status: subscriptions.status, cancelledAt: subscriptions.cancelledAt })
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, s.id));
    expect(row).toEqual({ status: 'cancelled', cancelledAt: expect.any(Date) });
    expect((await api(t, s.owner).post('/stores', { name: 'No', code: 'NO2' })).statusCode).toBe(
      403,
    );

    await pay(s, 'starter');
    expect(await status(s.member)).toMatchObject({
      plan: 'starter',
      status: 'active',
      readOnly: false,
    });
    // The old gateway subscription no longer speaks for the business.
    const stale = fake.webhook('payment_failed', firstId);
    expect(ok(await webhook(stale.body, stale.headers)).json()).toEqual({ received: 'ignored' });
    expect((await status(s.member)).status).toBe('active');
  });

  it('ignores a first payment that failed before the checkout was paid', async () => {
    const s = await shop('Declined Paints', 1);
    const started = ok(await change(s, 'starter')).json<PlanChangeResult>();
    if (started.kind !== 'checkout') throw new Error('Expected a checkout');
    const subscriptionId = String(
      fake.calls.findLast((call) => call.method === 'create')?.subscriptionId,
    );
    const failed = fake.webhook('payment_failed', subscriptionId);
    expect(ok(await webhook(failed.body, failed.headers)).json()).toEqual({ received: 'ignored' });
    expect((await status(s.owner)).status).toBe('trialing');
  });
});

describe('trial expiry and the platform console', () => {
  it('makes an expired trial read-only; the operator can extend it', async () => {
    const s = await shop('Expired Paints', 1);
    await shift(s, 'trial_ends_at', -1);
    expect(await status(s.member)).toMatchObject({ status: 'expired', readOnly: true });
    const refused = await api(t, s.owner).post('/stores', { name: 'No', code: 'NO3' });
    expect(refused.json<{ message: string }>().message).toBe(
      'Your free trial has ended, so the business is read-only. The owner can choose a plan under Billing.',
    );
    const listed = ok(await api(t, operator).get(`/platform/tenants/${s.id}`)).json<TenantDetail>();
    expect(listed.subscription).toEqual({
      status: 'expired',
      readOnly: true,
      trialEndsAt: expect.any(String),
      currentPeriodEnd: null,
      interval: null,
      gateway: null,
    });
    expect(
      (await api(t, operator).post(`/platform/tenants/${s.id}/extend-trial`, { days: 0 }))
        .statusCode,
    ).toBe(400);
    const extended = ok(
      await api(t, operator).post(`/platform/tenants/${s.id}/extend-trial`, { days: 7 }),
    ).json<TenantDetail>();
    expect(extended.subscription).toMatchObject({ status: 'trialing', readOnly: false });
    expect((await status(s.member)).trialDaysLeft).toBe(7);
    // Again from the current end, not from today.
    ok(await api(t, operator).post(`/platform/tenants/${s.id}/extend-trial`, { days: 3 }));
    expect((await status(s.member)).trialDaysLeft).toBe(10);
    expect((await api(t, s.owner).post('/platform/tenants', {})).statusCode).toBe(401);

    await pay(s, 'starter');
    const paid = await api(t, operator).post(`/platform/tenants/${s.id}/extend-trial`, { days: 7 });
    expect([paid.statusCode, paid.json<{ message: string }>().message]).toEqual([
      409,
      'Only a business on its free trial can have the trial extended',
    ]);
    const unknown = await api(t, operator).post(
      `/platform/tenants/${crypto.randomUUID()}/extend-trial`,
      { days: 7 },
    );
    expect(unknown.statusCode).toBe(404);
  });

  it('records the operator’s plan changes; a plan set by hand is active, the trial starts afresh', async () => {
    const s = await shop('Console Paints', 1);
    ok(await api(t, operator).patch(`/platform/tenants/${s.id}`, { plan: 'enterprise' }));
    expect(await status(s.owner)).toMatchObject({
      plan: 'enterprise',
      status: 'active',
      readOnly: false,
    });
    const billing = await view(s);
    expect(billing.history[0]).toMatchObject({
      fromPlan: 'trial',
      toPlan: 'enterprise',
      source: 'operator',
    });
    expect(billing.gateway).toBeNull();
    // A plan set by hand pays through the gateway when the owner chooses one.
    expect(ok(await change(s, 'standard')).json<PlanChangeResult>().kind).toBe('checkout');
    ok(await api(t, operator).patch(`/platform/tenants/${s.id}`, { plan: 'trial' }));
    expect(await status(s.owner)).toMatchObject({
      plan: 'trial',
      status: 'trialing',
      trialDaysLeft: 14,
    });
    // Renaming alone records no plan change.
    ok(await api(t, operator).patch(`/platform/tenants/${s.id}`, { name: 'Console Paints Ltd' }));
    expect((await view(s)).history).toHaveLength(3);

    await pay(s, 'standard');
    ok(await api(t, operator).patch(`/platform/tenants/${s.id}`, { plan: 'enterprise' }));
    // A business paying online stays on the gateway.
    expect(await view(s)).toMatchObject({ plan: 'enterprise', gateway: 'fake', status: 'active' });

    const onboarded = ok(
      await api(t, operator).post('/platform/tenants', {
        organizationName: 'Onboarded Paints',
        plan: 'standard',
        owner: { fullName: 'Onboarded Owner', phone: uniquePhone() },
      }),
    ).json<TenantDetail>();
    expect(onboarded.subscription).toMatchObject({ status: 'active', gateway: null });
  });
});

describe('tenant isolation', () => {
  it('lets a business read only its own subscription rows, and write none', async () => {
    const mine = await shop('Isolated Paints', 1);
    const theirs = await shop('Neighbour Paints', 1);
    await pay(theirs, 'starter');
    await withTenant(t.connection.db, mine.id, async (tx) => {
      const seen = await tx.select({ id: subscriptions.organizationId }).from(subscriptions);
      expect(seen).toEqual([{ id: mine.id }]);
      expect(await tx.select().from(subscriptionInvoices)).toEqual([]);
      expect(
        (await tx.select().from(subscriptionPlanChanges)).every(
          (row) => row.organizationId === mine.id,
        ),
      ).toBe(true);
    });
    for (const write of [
      sql`update subscriptions set status = 'active' where organization_id = ${mine.id}`,
      sql`insert into subscription_plan_changes (organization_id, to_plan, source) values (${mine.id}, 'enterprise', 'signup')`,
      sql`select * from payment_gateway_events`,
      sql`select * from subscription_invoice_sequences`,
    ]) {
      await expect(
        withTenant(t.connection.db, mine.id, (tx) => tx.execute(write)),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    }
    await expect(
      withTenant(t.connection.db, mine.id, (tx) =>
        tx.update(organizations).set({ plan: 'enterprise' }).where(eq(organizations.id, mine.id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
