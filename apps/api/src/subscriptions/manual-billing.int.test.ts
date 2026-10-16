import { migrateDatabase, schema, withTenant } from '@paint/db';
import {
  type PlanChangeResult,
  type SubscriptionInvoiceView,
  type SubscriptionStatusView,
  type SubscriptionView,
  type TenantBillingView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { api, dbToday, issuesOf, ok } from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import { ManualBillingService } from './manual-billing.js';

// Manual invoicing (the default, SUBSCRIPTION_GATEWAY unset): the owner asks for a
// plan, an operator applies it, we raise our invoices, an operator records the bank
// transfer or UPI payment. Every moment comes from the database clock.

const { organizations, subscriptionPayments, subscriptionPlanRequests, subscriptions } = schema;
const BOOTSTRAP_TOKEN = 'platform-bootstrap-token-for-manual-billing-tests';

let database: TestDatabase;
let t: TestApp;
let operator: string;
let billingService: ManualBillingService;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString, {
    SIGNUP_PLAN: 'trial',
    PLATFORM_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    PLATFORM_BANK_NAME: 'HDFC Bank, Banjara Hills',
    PLATFORM_BANK_ACCOUNT_NAME: 'Avali Tech Private Limited',
    PLATFORM_BANK_ACCOUNT_NUMBER: '50200012345678',
    PLATFORM_BANK_IFSC: 'HDFC0000123',
    PLATFORM_UPI_ID: 'avalitech@hdfcbank',
  });
  billingService = t.app.get(ManualBillingService);
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
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

interface Shop {
  readonly id: string;
  readonly owner: string;
  readonly member: string;
}

/** A business that signed itself up on the trial, with `stores` stores and a manager. */
async function shop(name: string, stores = 2): Promise<Shop> {
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
  for (let index = 0; index < stores; index++) {
    ok(await o.post('/stores', { name: `Store ${String(index)}`, code: `S${String(index)}` }));
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
  return { id: signup.organizationId, owner: signup.token, member };
}

const view = async (s: Shop) =>
  ok(await api(t, s.owner).get('/subscription')).json<SubscriptionView>();
const status = async (token: string) =>
  ok(await api(t, token).get('/subscription/status')).json<SubscriptionStatusView>();
const ask = (s: Shop, plan: string, interval = 'monthly') =>
  api(t, s.owner).post('/subscription/change', { plan, interval });
const invoices = async (s: Shop) =>
  ok(await api(t, s.owner).get('/subscription/invoices')).json<SubscriptionInvoiceView[]>();
const billing = async (s: Shop) =>
  ok(await api(t, operator).get(`/platform/tenants/${s.id}/billing`)).json<TenantBillingView>();
const apply = (s: Shop, requestId: string) =>
  api(t, operator).post(`/platform/tenants/${s.id}/plan-requests/${requestId}/apply`);
const record = (s: Shop, invoiceId: string, payment: Record<string, unknown>) =>
  api(t, operator).post(`/platform/tenants/${s.id}/invoices/${invoiceId}/payments`, payment);

/** India dates from the database clock: today plus `days`, and a period's last day. */
async function day(expression: string): Promise<string> {
  const result = await t.connection.db.execute<{ day: string }>(
    sql`select (${sql.raw(expression)})::date::text as day`,
  );
  return (result.rows[0] as { day: string }).day;
}
const today = (days = 0) => day(`(now() at time zone 'Asia/Kolkata')::date + ${String(days)}`);

/** Asks for `plan`, has the operator apply it and answers the first invoice. */
async function subscribe(s: Shop, plan = 'standard', interval = 'monthly') {
  const asked = ok(await ask(s, plan, interval)).json<PlanChangeResult>();
  if (asked.kind !== 'requested') throw new Error('Expected a request');
  ok(await apply(s, asked.request.id));
  const [invoice] = (await invoices(s)) as [SubscriptionInvoiceView];
  return invoice;
}

/** Moves the end of the paid period to the start of the India day `days` from today. */
const periodEndsIn = (s: Shop, days: number) =>
  t.connection.db.execute(sql`update subscriptions
    set current_period_start = (((now() at time zone 'Asia/Kolkata')::date + ${days}::int - 30)::timestamp at time zone 'Asia/Kolkata'),
        current_period_end = (((now() at time zone 'Asia/Kolkata')::date + ${days}::int)::timestamp at time zone 'Asia/Kolkata')
    where organization_id = ${s.id}`);

const payment = (amountPaise: number, paidOn: string) => ({
  amountPaise,
  paidOn,
  mode: 'bank_transfer',
  reference: 'UTR HDFCR52026101600123',
});

describe('asking for a plan', () => {
  it('shows the owner our bank details and takes a request instead of a checkout', async () => {
    const s = await shop('Request Paints');
    const before = await view(s);
    expect(before).toMatchObject({
      status: 'trialing',
      collection: 'manual',
      gateway: null,
      planRequest: null,
      paymentInstructions: {
        bankName: 'HDFC Bank, Banjara Hills',
        accountName: 'Avali Tech Private Limited',
        accountNumber: '50200012345678',
        ifsc: 'HDFC0000123',
        upiId: 'avalitech@hdfcbank',
      },
    });

    const tooSmall = await ask(s, 'starter');
    expect([tooSmall.statusCode, tooSmall.json<{ code: string }>().code]).toEqual([
      409,
      'plan_limits_exceeded',
    ]);
    expect(
      (
        await api(t, s.member).post('/subscription/change', {
          plan: 'standard',
          interval: 'monthly',
        })
      ).statusCode,
    ).toBe(403);

    const first = ok(await ask(s, 'standard')).json<PlanChangeResult>();
    expect(first).toEqual({
      kind: 'requested',
      request: {
        id: expect.any(String),
        plan: 'standard',
        interval: 'monthly',
        status: 'open',
        requestedBy: 'Request Paints Owner',
        createdAt: expect.any(String),
        decidedAt: null,
      },
    });
    // A newer request replaces the open one.
    const second = ok(await ask(s, 'enterprise', 'annual')).json<PlanChangeResult>();
    expect((await view(s)).planRequest).toMatchObject({ plan: 'enterprise', interval: 'annual' });
    const listed = await billing(s);
    expect(listed).toMatchObject({
      collection: 'manual',
      planRequest: { plan: 'enterprise', status: 'open' },
      invoices: [],
    });
    expect(listed.requests.map((request) => [request.plan, request.status])).toEqual([
      ['enterprise', 'open'],
      ['standard', 'cancelled'],
    ]);
    expect(listed.requests[1]?.decidedAt).not.toBeNull();
    // Nothing changed for the business yet.
    expect(await status(s.member)).toMatchObject({ plan: 'trial', status: 'trialing' });
    expect(second.kind).toBe('requested');
  });

  it('lets the operator decline a request, once', async () => {
    const s = await shop('Declined Paints');
    const asked = ok(await ask(s, 'standard')).json<PlanChangeResult>();
    if (asked.kind !== 'requested') throw new Error('Expected a request');
    const declined = ok(
      await api(t, operator).post(
        `/platform/tenants/${s.id}/plan-requests/${asked.request.id}/decline`,
      ),
    ).json<TenantBillingView>();
    expect(declined.planRequest).toBeNull();
    expect(declined.requests[0]).toMatchObject({
      status: 'cancelled',
      decidedAt: expect.any(String),
    });
    const again = await apply(s, asked.request.id);
    expect([again.statusCode, again.json<{ message: string }>().message]).toEqual([
      409,
      'This plan request has already been decided',
    ]);
    expect((await apply(s, crypto.randomUUID())).statusCode).toBe(404);
    expect(
      (await api(t, operator).get(`/platform/tenants/${crypto.randomUUID()}/billing`)).statusCode,
    ).toBe(404);
    expect((await api(t, s.owner).get(`/platform/tenants/${s.id}/billing`)).statusCode).toBe(401);
  });
});

describe('the first invoice and its payment', () => {
  it('raises our invoice when the request is applied; the payment starts the plan', async () => {
    const s = await shop('First Invoice Paints');
    const invoice = await subscribe(s);
    expect(invoice).toEqual({
      id: expect.any(String),
      number: expect.stringMatching(/^PRS\/\d{2}-\d{2}\/\d{6}$/) as string,
      issuedOn: await dbToday(t),
      plan: 'standard',
      interval: 'monthly',
      quantity: 2,
      periodStart: await today(),
      periodEnd: await day(
        `((now() at time zone 'Asia/Kolkata')::date + interval '1 month')::date - 1`,
      ),
      taxablePaise: 2_998_00,
      taxPaise: 539_64,
      totalPaise: 3_537_64,
      dueOn: await today(),
      payment: null,
    });
    // The plan waits for the money: still the trial, and the request is applied.
    expect(await status(s.member)).toMatchObject({ plan: 'trial', status: 'trialing' });
    expect((await billing(s)).requests[0]?.status).toBe('applied');

    const pdf = await api(t, s.owner).get(`/subscription/invoices/${invoice.id}/pdf`);
    expect([pdf.statusCode, pdf.headers['content-type']]).toEqual([200, 'application/pdf']);
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');

    // Another change waits until this invoice is paid.
    const more = ok(await ask(s, 'enterprise')).json<PlanChangeResult>();
    if (more.kind !== 'requested') throw new Error('Expected a request');
    const blocked = await apply(s, more.request.id);
    expect([blocked.statusCode, blocked.json<{ message: string }>().message]).toEqual([
      409,
      `Invoice ${invoice.number} is not paid yet. Record its payment before changing the plan.`,
    ]);

    const tooMuch = await record(s, invoice.id, payment(3_537_65, await today()));
    expect([tooMuch.statusCode, issuesOf(tooMuch)]).toEqual([400, ['amountPaise']]);
    const tomorrow = await record(s, invoice.id, payment(3_537_64, await today(1)));
    expect([tomorrow.statusCode, issuesOf(tomorrow)]).toEqual([400, ['paidOn']]);
    const blank = await record(s, invoice.id, {
      ...payment(3_537_64, await today()),
      reference: ' ',
    });
    expect(blank.statusCode).toBe(400);
    expect((await record(s, crypto.randomUUID(), payment(1, await today()))).statusCode).toBe(404);

    const paid = ok(
      await record(s, invoice.id, payment(3_537_64, await today())),
    ).json<TenantBillingView>();
    expect(paid.invoices[0]?.payment).toEqual({
      mode: 'bank_transfer',
      amountPaise: 3_537_64,
      paidOn: await today(),
      reference: 'UTR HDFCR52026101600123',
    });
    const again = await record(s, invoice.id, payment(3_537_64, await today()));
    expect([again.statusCode, again.json<{ message: string }>().message]).toEqual([
      409,
      `Invoice ${invoice.number} is already paid`,
    ]);

    const active = await view(s);
    expect(active).toMatchObject({
      plan: 'standard',
      status: 'active',
      readOnly: false,
      trialEndsAt: null,
      gateway: 'manual',
      interval: 'monthly',
      quantity: 2,
      // The enterprise request is still waiting for the operator.
      planRequest: { plan: 'enterprise', status: 'open' },
    });
    // Paid to the end of the invoice's last day, India time.
    const [end] = (
      await t.connection.db.execute<{ day: string }>(
        sql`select ((current_period_end at time zone 'Asia/Kolkata') - interval '1 second')::date::text as day,
          (current_period_end at time zone 'Asia/Kolkata')::time::text as at
          from subscriptions where organization_id = ${s.id}`,
      )
    ).rows as [{ day: string; at: string }];
    expect(end).toEqual({ day: invoice.periodEnd, at: '00:00:00' });
    expect(active.history[0]).toMatchObject({
      fromPlan: 'trial',
      toPlan: 'standard',
      interval: 'monthly',
      source: 'operator',
    });

    // Already on it: refused.
    expect((await ask(s, 'standard')).statusCode).toBe(409);
    // A running business changes in place: limits now, the price from the next invoice.
    const open = (await view(s)).planRequest;
    ok(await apply(s, String(open?.id)));
    expect(await view(s)).toMatchObject({ plan: 'enterprise', interval: 'monthly' });
    expect(await invoices(s)).toHaveLength(1);
  });

  it('refuses to apply a plan the business has outgrown since asking', async () => {
    const s = await shop('Outgrown Paints', 1);
    const asked = ok(await ask(s, 'starter')).json<PlanChangeResult>();
    if (asked.kind !== 'requested') throw new Error('Expected a request');
    ok(await api(t, s.owner).post('/stores', { name: 'Second', code: 'S9' }));
    const refused = await apply(s, asked.request.id);
    expect([refused.statusCode, refused.json<{ code: string }>().code]).toEqual([
      409,
      'plan_limits_exceeded',
    ]);
  });

  it('leaves a business paying online to its gateway', async () => {
    const s = await shop('Online Paints', 1);
    const asked = ok(await ask(s, 'standard')).json<PlanChangeResult>();
    if (asked.kind !== 'requested') throw new Error('Expected a request');
    // As if it had subscribed through Razorpay before the platform invoiced by hand.
    await t.connection.db
      .execute(sql`update subscriptions set status = 'active', gateway = 'razorpay',
      gateway_subscription_id = 'sub_online', billing_interval = 'monthly', store_quantity = 1,
      trial_ends_at = null, current_period_start = now(), current_period_end = now() + interval '1 month'
      where organization_id = ${s.id}`);
    const refused = await apply(s, asked.request.id);
    expect([refused.statusCode, refused.json<{ message: string }>().message]).toEqual([
      409,
      'This business pays online; its owner changes the plan under Billing.',
    ]);
  });
});

describe('renewals', () => {
  it('raises the next invoice a week ahead; unpaid past the period and the grace days, the business is read-only', async () => {
    const s = await shop('Renewal Paints', 1);
    const first = await subscribe(s, 'starter');
    ok(await record(s, first.id, payment(first.totalPaise, await today())));
    // A month away: nothing to raise yet.
    await billingService.raiseRenewals();
    expect(await invoices(s)).toHaveLength(1);

    await periodEndsIn(s, 5);
    expect(await billingService.raiseRenewals()).toBeGreaterThanOrEqual(1);
    const [renewal] = await invoices(s);
    expect(renewal).toMatchObject({
      plan: 'starter',
      issuedOn: await today(),
      periodStart: await today(5),
      periodEnd: await day(
        `((now() at time zone 'Asia/Kolkata')::date + 5 + interval '1 month')::date - 1`,
      ),
      dueOn: await today(5),
      payment: null,
    });
    // Once per period, and never while it is unpaid.
    await billingService.raiseRenewals();
    expect(await invoices(s)).toHaveLength(2);
    const cancel = await api(t, s.owner).post('/subscription/cancel');
    expect([cancel.statusCode, cancel.json<{ message: string }>().message]).toEqual([
      409,
      `Invoice ${String(renewal?.number)} for your next period is already raised. Contact us to cancel.`,
    ]);

    await periodEndsIn(s, -1);
    expect(await status(s.member)).toMatchObject({ status: 'past_due', readOnly: false });
    await periodEndsIn(s, -8);
    expect(await status(s.member)).toMatchObject({ status: 'past_due', readOnly: true });
    const refused = await api(t, s.owner).post('/brands', { name: 'Refused' });
    expect([refused.statusCode, refused.json<{ code: string }>().code]).toEqual([
      403,
      'subscription_read_only',
    ]);
    // The owner still sees what to pay.
    expect((await view(s)).paymentInstructions).not.toBeNull();

    // Paid late, less TDS: the business works again, to the end of the renewal's period.
    ok(
      await record(s, String(renewal?.id), {
        amountPaise: Number(renewal?.totalPaise) - 79_90,
        paidOn: await today(),
        mode: 'upi',
        reference: 'UPI 612345678901',
      }),
    );
    expect(await status(s.member)).toMatchObject({ status: 'active', readOnly: false });
    expect((await view(s)).history[0]).toMatchObject({ fromPlan: 'trial', toPlan: 'starter' });
    expect(ok(await api(t, s.owner).post('/brands', { name: 'Back' })).statusCode).toBe(201);
  });

  it('raises nothing for a business that is cancelling or suspended', async () => {
    const leaving = await shop('Leaving Paints', 1);
    const first = await subscribe(leaving, 'starter', 'annual');
    ok(await record(leaving, first.id, payment(first.totalPaise, await today())));
    const cancelled = ok(
      await api(t, leaving.owner).post('/subscription/cancel'),
    ).json<SubscriptionView>();
    expect(cancelled.cancelAtPeriodEnd).toBe(true);

    const suspended = await shop('Suspended Paints', 1);
    const second = await subscribe(suspended, 'starter');
    ok(await record(suspended, second.id, payment(second.totalPaise, await today())));
    ok(
      await api(t, operator).post(`/platform/tenants/${suspended.id}/suspend`, {
        reason: 'Asked to pause',
      }),
    );

    await periodEndsIn(leaving, 2);
    await periodEndsIn(suspended, 2);
    await billingService.raiseRenewals();
    expect(await invoices(leaving)).toHaveLength(1);
    expect((await billingService.billing(suspended.id)).invoices).toHaveLength(1);
    await periodEndsIn(leaving, -1);
    expect(await status(leaving.member)).toMatchObject({ status: 'cancelled', readOnly: true });
    expect((await invoices(leaving))[0]).toMatchObject({
      interval: 'annual',
      periodEnd: await day(
        `((now() at time zone 'Asia/Kolkata')::date + interval '1 year')::date - 1`,
      ),
    });
  });

  it('makes a period invoiced late payable at once', async () => {
    const s = await shop('Late Invoice Paints', 1);
    const first = await subscribe(s, 'starter');
    ok(await record(s, first.id, payment(first.totalPaise, await today())));
    // The worker did not run for days: the period already started.
    await periodEndsIn(s, -3);
    await billingService.raiseRenewals();
    expect((await invoices(s))[0]).toMatchObject({
      periodStart: await today(-3),
      issuedOn: await today(),
      dueOn: await today(),
    });
  });
});

describe('the rules the database keeps', () => {
  it('lets a business read its requests and payments, write none, and keeps payments final', async () => {
    const s = await shop('Rules Paints', 1);
    const invoice = await subscribe(s, 'starter');
    ok(await record(s, invoice.id, payment(invoice.totalPaise, await today())));
    await withTenant(t.connection.db, s.id, async (tx) => {
      expect(await tx.select().from(subscriptionPayments)).toHaveLength(1);
      expect(await tx.select().from(subscriptionPlanRequests)).toHaveLength(1);
    });
    for (const write of [
      sql`update subscription_payments set amount_paise = 1`,
      sql`insert into subscription_plan_requests (organization_id, plan, billing_interval, requested_by_member_id)
        select organization_id, 'enterprise', 'monthly', requested_by_member_id from subscription_plan_requests`,
    ]) {
      await expect(
        withTenant(t.connection.db, s.id, (tx) => tx.execute(write)),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    }
    await expect(
      t.connection.db.execute(
        sql`update subscription_payments set reference = 'changed' where organization_id = ${s.id}`,
      ),
    ).rejects.toMatchObject({ cause: { code: '23001' } });
    await expect(
      t.connection.db.execute(
        sql`update subscription_plan_requests set status = 'open', decided_at = null, decided_by_user_id = null
          where organization_id = ${s.id}`,
      ),
    ).rejects.toMatchObject({ cause: { code: '23001' } });
    const [business] = await t.connection.db
      .select({ plan: organizations.plan })
      .from(organizations)
      .where(eq(organizations.id, s.id));
    expect(business?.plan).toBe('starter');
    const [row] = await t.connection.db
      .select({ gateway: subscriptions.gateway, id: subscriptions.gatewaySubscriptionId })
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, s.id));
    expect(row).toEqual({ gateway: 'manual', id: null });
  });

  it('settles only a manual invoice of the same business, for at most its total', async () => {
    const s = await shop('Trigger Paints', 1);
    const invoice = await subscribe(s, 'starter');
    const insert = (amount: number, organizationId = s.id) =>
      t.connection.db.execute(sql`insert into subscription_payments
        (organization_id, invoice_id, amount_paise, paid_on, mode, reference, recorded_by_user_id)
        select ${organizationId}, ${invoice.id}, ${amount}, current_date, 'upi', 'ref', id from users limit 1`);
    await expect(insert(invoice.totalPaise + 1)).rejects.toMatchObject({
      cause: { code: '23514' },
    });
    await t.connection.db.execute(
      sql`update subscriptions set status = 'active' where organization_id = ${s.id}`,
    );
    // An online invoice is settled by its gateway.
    const online = await t.connection.db.execute<{ id: string }>(sql`
      insert into subscription_invoices (organization_id, number, financial_year, serial, issued_on, plan,
        billing_interval, store_quantity, unit_price_paise, period_start, period_end, sac_code, rate_bps,
        place_of_supply, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, supplier, buyer,
        due_on, gateway, gateway_payment_id)
      select organization_id, 'ONLINE/1', financial_year, serial + 1000, issued_on, plan, billing_interval,
        store_quantity, unit_price_paise, period_start, period_end, sac_code, rate_bps, place_of_supply,
        taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, supplier, buyer, due_on, 'fake', 'pay_1'
      from subscription_invoices where id = ${invoice.id} returning id`);
    const onlineId = String(online.rows[0]?.id);
    await expect(
      t.connection.db.execute(sql`insert into subscription_payments
        (organization_id, invoice_id, amount_paise, paid_on, mode, reference, recorded_by_user_id)
        select ${s.id}, ${onlineId}, 1, current_date, 'upi', 'ref', id from users limit 1`),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});
