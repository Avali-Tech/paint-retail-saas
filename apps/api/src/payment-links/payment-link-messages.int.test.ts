import { migrateDatabase, postPartyLedger, schema, withTenant } from '@paint/db';
import type { PaymentLinkView, PaymentView, StatementShareResult } from '@paint/shared';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { runCollections } from '../collections/collections-job.js';
import { Notifier } from '../notifications/notifier.js';
import {
  api,
  billingBusiness,
  dbToday,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import { PAYMENT_LINK_GATEWAYS, type PaymentLinkGateways } from './payment-link-gateways.js';
import { LOG_SIGNATURE_HEADER, type LogPaymentLinkProvider } from './payment-link-provider.js';

// Payment links on the messages that ask for money (spec §6.2 rule PL-12): the
// collections run's reminders and statement shares, and the round 4 demo.

const { allocations, messageOutbox, partyBalances, paymentLinks, payments } = schema;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let today: string;

const settings = () => t.app.get<PaymentLinkGateways>(PAYMENT_LINK_GATEWAYS, { strict: false });
/** The log gateway, on in this app. */
const provider = (): LogPaymentLinkProvider => {
  const log = settings().log;
  if (log === null) throw new Error('No log gateway');
  return log;
};

async function customer(body: object = {}): Promise<string> {
  return ok(
    await api(t, b.owner).post('/parties', {
      displayName: `Customer ${uniquePhone()}`,
      phone: uniquePhone(),
      roles: ['customer'],
      homeStoreId: b.stores.amp,
      ...body,
    }),
  ).json<{ id: string }>().id;
}

async function bill(partyId: string, quantity: number, dueOn: string, storeId = b.stores.amp) {
  const draft = await b.draft({
    storeId,
    partyId,
    dueOn,
    lines: [{ variantId: b.apex, quantity }],
  });
  return ok(await api(t, b.owner).post(`/invoices/${draft.id}/issue`, {})).json<{
    id: string;
    number: string;
  }>();
}

async function grant(partyId: string, channel: 'whatsapp' | 'sms', language = 'en') {
  ok(
    await api(t, b.owner).post(`/parties/${partyId}/consents`, {
      channel,
      state: 'granted',
      method: 'counter_with_notice',
      language,
      noticeVersion: '2026-10',
    }),
  );
}

const runReminders = () =>
  withTenant(t.connection.db, b.organizationId, (tx) =>
    runCollections(tx, t.app.get(Notifier), b.organizationId, settings()),
  );

/** Lets the daily run happen again (tests only; runs are append-only to tenants). */
async function forgetRuns() {
  await withPgClient(database.connectionString, async (client) => {
    await client.query('ALTER TABLE collection_runs DISABLE TRIGGER collection_runs_append_only');
    await client.query('DELETE FROM collection_runs');
    await client.query('ALTER TABLE collection_runs ENABLE TRIGGER collection_runs_append_only');
  });
}

const linksOf = (partyId: string) =>
  t.connection.db
    .select()
    .from(paymentLinks)
    .where(eq(paymentLinks.partyId, partyId))
    .orderBy(asc(paymentLinks.createdAt));

const messagesOf = (partyId: string) =>
  t.connection.db
    .select({
      channel: messageOutbox.channel,
      templateKey: messageOutbox.templateKey,
      body: messageOutbox.body,
      variables: messageOutbox.variables,
    })
    .from(messageOutbox)
    .where(eq(messageOutbox.partyId, partyId))
    .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.channel));

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString, {
    PAYMENT_LINK_PROVIDER: 'log',
    MESSAGING_PROVIDER: 'log',
    SMS_PROVIDER: 'log',
    APP_URL: 'https://app.example.in',
  });
  b = await billingBusiness(t);
  today = await dbToday(t);
  ok(
    await api(t, b.owner).put('/collections/reminder-schedules', {
      schedules: [{ offsetDays: 7, channels: ['whatsapp', 'sms'], isActive: true }],
    }),
  );
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('the round 4 demo', () => {
  it('a reminder paid through the log gateway’s signed webhook is recorded and allocated with no manual entry; a replay changes nothing', async () => {
    const krishna = await customer({ displayName: 'Krishna Constructions' });
    const late = await bill(krishna, 5, await dbToday(t, -7)); // ₹590, due a week ago
    await grant(krishna, 'whatsapp');
    await grant(krishna, 'sms');

    // The morning's collections run sends the reminder, with a UPI link for the bill.
    expect(await runReminders()).toMatchObject({ remindersQueued: 2 });
    const [link] = await linksOf(krishna);
    expect(link).toMatchObject({
      purpose: 'bills',
      origin: 'reminder',
      amountPaise: 59_000,
      storeId: b.stores.amp,
      createdByMemberId: null,
      status: 'created',
    });
    const reminders = await messagesOf(krishna);
    expect(reminders.map((message) => [message.channel, message.templateKey])).toEqual([
      ['whatsapp', 'payment_reminder_overdue'],
      ['sms', 'payment_reminder_overdue'],
    ]);
    for (const reminder of reminders) {
      expect(reminder.body).toMatch(
        /^Dear Krishna Constructions, ₹590\.00 owed to .+ is overdue by 7 days\. Please pay at the earliest\. Pay by UPI: https:\/\/app\.example\.in\/pay\/plink_log_[\w-]{22}$/,
      );
      expect(reminder.body).toContain(String(link?.url));
    }

    // Krishna pays by UPI; the gateway posts its signed webhook.
    const webhook = provider().webhook({
      type: 'payment.captured',
      linkId: String(link?.gatewayReference),
      payment: { amountPaise: 59_000 },
    });
    const deliver = () =>
      t.app.inject({
        method: 'POST',
        url: '/webhooks/payment-links/log',
        headers: { 'content-type': 'application/json', [LOG_SIGNATURE_HEADER]: webhook.signature },
        payload: webhook.body,
      });
    expect(ok(await deliver()).json()).toEqual({ received: 'applied' });

    const state = async () => ({
      payments: await t.connection.db
        .select({ id: payments.id, amount: payments.amountPaise, mode: payments.modeKind })
        .from(payments)
        .where(eq(payments.partyId, krishna)),
      allocations: await t.connection.db
        .select({ document: allocations.documentId, amount: allocations.amountPaise })
        .from(allocations)
        .where(eq(allocations.partyId, krishna)),
      balance: await t.connection.db
        .select({ balance: partyBalances.balancePaise, advance: partyBalances.advancePaise })
        .from(partyBalances)
        .where(eq(partyBalances.partyId, krishna)),
      link: (await linksOf(krishna)).map((row) => [row.status, row.paidPaise]),
      messages: (await messagesOf(krishna)).length,
    });
    const after = await state();
    expect(after).toMatchObject({
      payments: [{ amount: 59_000, mode: 'upi_link' }],
      allocations: [{ document: late.id, amount: 59_000 }],
      balance: [{ balance: 0, advance: 0 }],
      link: [['paid', 59_000]],
    });
    const payment = ok(
      await api(t, b.owner).get(`/payments/${String(after.payments[0]?.id)}`),
    ).json<PaymentView>();
    expect(payment.createdByMemberId).toBeNull();

    // The gateway retries the same webhook: nothing changes.
    expect(ok(await deliver()).json()).toEqual({ received: 'duplicate' });
    expect(await state()).toEqual(after);
  });
});

describe('reminders with payment links', () => {
  it('share one link per party across channels and send it again on another run', async () => {
    const party = await customer();
    await bill(party, 1, await dbToday(t, -7));
    await grant(party, 'whatsapp');
    await forgetRuns();
    await runReminders();
    const [first] = await linksOf(party);
    await forgetRuns();
    await runReminders();
    expect(await linksOf(party)).toEqual([first]);
  });

  it('carry no link to a party nobody can message, or whose advance covers the bills', async () => {
    const silent = await customer();
    await bill(silent, 1, await dbToday(t, -7));
    const covered = await customer();
    await bill(covered, 1, await dbToday(t, -7));
    await grant(covered, 'sms');
    ok(
      await api(t, b.owner).post('/payments', {
        storeId: b.stores.amp,
        partyId: covered,
        modeId: b.modes.upi.id,
        amountPaise: 11_800,
        allocations: [],
      }),
    );
    await forgetRuns();
    await runReminders();
    expect(await linksOf(silent)).toEqual([]);
    expect(await linksOf(covered)).toEqual([]);
    const [reminder] = await messagesOf(covered);
    expect(reminder?.body).toMatch(/Please pay at the earliest\.$/);
    expect(reminder?.variables).toMatchObject({ payLink: '' });
  });

  it('records a reminder link at the oldest bill’s store for a party with no home store', async () => {
    const party = await customer({ homeStoreId: undefined });
    await bill(party, 1, await dbToday(t, -7), b.stores.kkp);
    await grant(party, 'whatsapp');
    await forgetRuns();
    await runReminders();
    expect((await linksOf(party)).map((link) => link.storeId)).toEqual([b.stores.kkp]);
  });
});

describe('statement shares with payment links', () => {
  const share = (partyId: string, body: object = {}, token = b.owner) =>
    api(t, token).post(`/parties/${partyId}/statement/links`, {
      from: '2026-04-01',
      to: today,
      lang: 'en',
      ...body,
    });

  it('name the link’s amount when it asks for the bills’ full outstanding beside an advance ([PO-43])', async () => {
    const setBasis = async (amountBasis: 'net' | 'full') =>
      ok(
        await api(t, b.owner).put('/payment-links/settings', {
          validityMinutes: 10,
          capPaise: 10_000_000,
          amountBasis,
        }),
      );
    const party = await customer();
    await bill(party, 2, await dbToday(t, 10));
    await grant(party, 'whatsapp');
    // An advance of ₹36.00 beside the bill of ₹236.00.
    ok(
      await api(t, b.owner).post('/payments', {
        storeId: b.stores.amp,
        partyId: party,
        modeId: b.modes.upi.id,
        amountPaise: 3_600,
        allocations: [],
      }),
    );
    const net = ok(await share(party)).json<StatementShareResult>();
    expect(net.paymentLink?.amountPaise).toBe(20_000);
    expect(decodeURIComponent(String(net.waMeUrl))).toContain(' Pay by UPI: ');

    await setBasis('full');
    try {
      const full = ok(await share(party, { send: 'whatsapp' })).json<StatementShareResult>();
      expect(full.paymentLink?.amountPaise).toBe(23_600);
      expect(decodeURIComponent(String(full.waMeUrl))).toContain(
        `Pay ₹236.00 by UPI: ${String(full.paymentLink?.url)}`,
      );
      const [message] = (await messagesOf(party)).slice(-1);
      expect(message?.body).toContain(`balance ₹200.00`);
      expect(message?.body).toContain(`Pay ₹236.00 by UPI: ${String(full.paymentLink?.url)}`);
    } finally {
      await setBasis('net');
    }
  });

  it('carry a UPI link for what the party owes, sent again until something changes', async () => {
    const party = await customer();
    await bill(party, 2, await dbToday(t, 10));
    await grant(party, 'whatsapp', 'te');
    const shared = ok(await share(party, { send: 'whatsapp' })).json<StatementShareResult>();
    const [link] = await linksOf(party);
    expect(link).toMatchObject({
      purpose: 'outstanding',
      origin: 'statement',
      amountPaise: 23_600,
      storeId: b.stores.amp,
    });
    expect(shared.paymentLink).toEqual({ number: link?.number, url: link?.url, amountPaise: 23_600 });
    expect(decodeURIComponent(String(shared.waMeUrl))).toContain(
      `View the statement: ${shared.url} Pay by UPI: ${String(link?.url)}`,
    );
    const [message] = await messagesOf(party);
    expect(message).toMatchObject({ templateKey: 'statement_ready' });
    expect(message?.body).toContain(`UPI ద్వారా చెల్లించండి: ${String(link?.url)}`);

    const again = ok(await share(party)).json<StatementShareResult>();
    expect(again.paymentLink).toEqual(shared.paymentLink);
    // Paid by hand, then another bill for the same amount: a new link for the new bill.
    ok(
      await api(t, b.owner).post('/payments', {
        storeId: b.stores.amp,
        partyId: party,
        modeId: b.modes.upi.id,
        amountPaise: 23_600,
      }),
    );
    const next = await bill(party, 2, await dbToday(t, 12));
    const changed = ok(await share(party)).json<StatementShareResult>();
    expect(changed.paymentLink?.number).not.toBe(shared.paymentLink?.number);
    const links = await linksOf(party);
    expect(links).toHaveLength(2);
    const newest = ok(
      await api(t, b.owner).get(`/payment-links/${String(links[1]?.id)}`),
    ).json<PaymentLinkView>();
    expect(newest.documents.map((document) => document.documentId)).toEqual([next.id]);
    const view = ok(
      await api(t, b.owner).get(`/payment-links/${String(link?.id)}`),
    ).json<PaymentLinkView>();
    expect(view.createdBy).toBe('Owner');
  });

  it('carry none when nothing is owed, or for a member who does not take payments there', async () => {
    const settled = await customer();
    expect(ok(await share(settled)).json<StatementShareResult>().paymentLink).toBeNull();

    const owing = await customer();
    await bill(owing, 1, await dbToday(t, 10));
    const employee = await b.member('store_employee', [b.stores.amp]);
    expect(
      ok(await share(owing, {}, employee)).json<StatementShareResult>().paymentLink,
    ).toBeNull();

    const homeless = await customer({ homeStoreId: undefined });
    await bill(homeless, 1, await dbToday(t, 10), b.stores.kkp);
    const ampSales = await b.member('sales_executive', [b.stores.amp]);
    expect(
      ok(await share(homeless, {}, ampSales)).json<StatementShareResult>().paymentLink,
    ).toBeNull();
    expect(ok(await share(homeless)).json<StatementShareResult>().paymentLink).not.toBeNull();
    expect((await linksOf(homeless)).map((link) => link.storeId)).toEqual([b.stores.kkp]);

    // Only an opening balance and no home store: no store to record the payment at.
    const opening = await customer({ homeStoreId: undefined });
    await withTenant(t.connection.db, b.organizationId, (tx) =>
      postPartyLedger(tx, [
        {
          organizationId: b.organizationId,
          partyId: opening,
          entryOn: '2026-04-01',
          entryType: 'opening',
          amountPaise: 5_000,
        },
      ]),
    );
    expect(ok(await share(opening)).json<StatementShareResult>().paymentLink).toBeNull();
  });
});
