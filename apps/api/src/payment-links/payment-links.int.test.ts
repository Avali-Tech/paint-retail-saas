import {
  findAllocationMismatches,
  findPartyBalanceMismatches,
  migrateDatabase,
  postPartyLedger,
  schema,
  withTenant,
} from '@paint/db';
import type {
  AuthProfile,
  LogCheckoutView,
  LogWebhook,
  PaymentLinkCreated,
  PaymentLinkPage,
  PaymentLinkSettings as PaymentLinkSettingsView,
  PaymentLinkView,
  PaymentView,
  ReceiptView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  dbToday,
  issuesOf,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import { PAYMENT_LINK_GATEWAYS, type PaymentLinkGateways } from './payment-link-gateways.js';
import { LOG_SIGNATURE_HEADER, LogPaymentLinkProvider } from './payment-link-provider.js';

const {
  messageOutbox,
  notifications,
  partyBalances,
  paymentGatewayEvents,
  paymentLinks,
  payments,
} = schema;

let database: TestDatabase;
/** Payment links and WhatsApp through the log providers. */
let t: TestApp;
/** Neither set up. */
let off: TestApp;
/** Payment links, but no WhatsApp. */
let quiet: TestApp;
let b: BillingBusiness;
let today: string;

/** The log gateway of an app that has it. */
const provider = (app = t): LogPaymentLinkProvider => {
  const log = app.app.get<PaymentLinkGateways>(PAYMENT_LINK_GATEWAYS, { strict: false }).log;
  if (log === null) throw new Error('This app has no log gateway');
  return log;
};
const referenceOf = (link: { url: string }) => String(link.url.split('/').at(-1));

const create = (body: object, token = b.owner, app = t) =>
  api(app, token).post('/payment-links', body);
const created = async (body: object, token = b.owner) =>
  ok(await create(body, token)).json<PaymentLinkCreated>();
const view = async (id: string, token = b.owner) =>
  ok(await api(t, token).get(`/payment-links/${id}`)).json<PaymentLinkView>();

/** Posts a signed webhook as the gateway would. */
const deliver = (body: Buffer, signature: string, app = t, path = '/webhooks/payment-links/log') =>
  app.app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json', [LOG_SIGNATURE_HEADER]: signature },
    payload: body,
  });

/** The gateway reports a payment on a link; answers the webhook and its signed body. */
async function payLink(
  link: { url: string },
  amountPaise: number,
  options: { id?: string; paymentId?: string; paidAt?: Date } = {},
) {
  const webhook = provider().webhook({
    type: 'payment.captured',
    linkId: referenceOf(link),
    payment: {
      amountPaise,
      ...(options.paymentId === undefined ? {} : { id: options.paymentId }),
      ...(options.paidAt === undefined ? {} : { paidAt: options.paidAt }),
    },
    ...(options.id === undefined ? {} : { id: options.id }),
  });
  const reply = await deliver(webhook.body, webhook.signature);
  return { reply, outcome: ok(reply).json<{ received: string }>().received, webhook };
}

async function linkEvent(link: { url: string }, type: string) {
  const webhook = provider().webhook({ type, linkId: referenceOf(link) });
  return ok(await deliver(webhook.body, webhook.signature)).json<{ received: string }>().received;
}

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

/** An issued invoice of `quantity` litres (₹118 each), due on `dueOn`. */
async function bill(partyId: string, quantity: number, dueOn?: string, storeId = b.stores.amp) {
  const draft = await b.draft({
    storeId,
    partyId,
    ...(dueOn === undefined ? {} : { dueOn }),
    lines: [{ variantId: b.apex, quantity }],
  });
  return ok(await api(t, b.owner).post(`/invoices/${draft.id}/issue`, {})).json<{
    id: string;
    number: string;
  }>();
}

async function grantWhatsapp(partyId: string, language = 'en') {
  ok(
    await api(t, b.owner).post(`/parties/${partyId}/consents`, {
      channel: 'whatsapp',
      state: 'granted',
      method: 'counter_with_notice',
      language,
      noticeVersion: '2026-10',
    }),
  );
}

const paymentsOf = (linkId: string) =>
  t.connection.db
    .select()
    .from(payments)
    .where(eq(payments.paymentLinkId, linkId))
    .orderBy(payments.createdAt, payments.id);

const balanceOf = async (partyId: string) => {
  const [row] = await t.connection.db
    .select({ balance: partyBalances.balancePaise, advance: partyBalances.advancePaise })
    .from(partyBalances)
    .where(eq(partyBalances.partyId, partyId));
  return row;
};

/** Σ party_ledger = party_balances and allocations agree, for the whole business. */
async function booksBalance() {
  await withTenant(t.connection.db, b.organizationId, async (tx) => {
    expect(await findPartyBalanceMismatches(tx)).toEqual([]);
    expect(await findAllocationMismatches(tx)).toEqual([]);
  });
}

/** The paid-link notices whose title has `title` (each member told gets a copy). */
const noticesOf = (
  title: string,
  event: 'payment_link_paid' | 'payment_link_refund' = 'payment_link_paid',
) =>
  t.connection.db
    .selectDistinct({
      title: notifications.title,
      body: notifications.body,
      link: notifications.link,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.organizationId, b.organizationId),
        eq(notifications.event, event),
        sql`${notifications.title} like ${`%${title}%`}`,
      ),
    );

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString, {
    PAYMENT_LINK_PROVIDER: 'log',
    MESSAGING_PROVIDER: 'log',
    APP_URL: 'https://app.example.in',
  });
  off = await startTestApp(database.connectionString);
  quiet = await startTestApp(database.connectionString, { PAYMENT_LINK_PROVIDER: 'log' });
  b = await billingBusiness(t);
  today = await dbToday(t);
});

afterAll(async () => {
  await t.close();
  await off.close();
  await quiet.close();
  await database.stop();
});

describe('payment link settings', () => {
  it('have no Razorpay account to connect with the log gateway', async () => {
    expect(ok(await api(t, b.owner).get('/payment-links/gateway-account')).json()).toBeNull();
    const connect = await api(t, b.owner).put('/payment-links/gateway-account', {
      keyId: 'rzp_test_1DP5mmOlF5G5ag',
      keySecret: 'abcdefghijklmnopqrst',
      webhookSecret: 'webhook-secret',
    });
    expect(connect.statusCode).toBe(409);
    expect(connect.json<{ code: string }>().code).toBe('gateway_not_razorpay');
    for (const reply of [
      await api(t, b.owner).post('/payment-links/gateway-account/test'),
      await api(t, b.owner).delete('/payment-links/gateway-account'),
    ]) {
      expect(reply.json<{ code: string }>().code).toBe('gateway_not_razorpay');
    }
  });

  it('say whether links can be made, and the business’s rules: 10 minutes, ₹1,00,000, net', async () => {
    const defaults = {
      validityMinutes: 10,
      capPaise: 10_000_000,
      amountBasis: 'net',
    };
    expect(
      ok(await api(t, b.owner).get('/payment-links/settings')).json<PaymentLinkSettingsView>(),
    ).toEqual({ provider: 'log', ready: true, ...defaults });
    expect(
      ok(await api(off, b.owner).get('/payment-links/settings')).json<PaymentLinkSettingsView>(),
    ).toEqual({ provider: null, ready: false, ...defaults });
  });
});

describe('making a payment link', () => {
  it('asks for an invoice’s outstanding at its store, with a wa.me message carrying the link', async () => {
    const party = await customer({ displayName: 'Lakshmi Traders' });
    const invoice = await bill(party, 10, undefined, b.stores.kkp);
    const result = await created({ partyId: party, purpose: 'invoice', invoiceId: invoice.id });

    expect(result.link).toMatchObject({
      number: expect.stringMatching(/^PL-\d{6}$/) as string,
      storeId: b.stores.kkp,
      partyId: party,
      partyName: 'Lakshmi Traders',
      purpose: 'invoice',
      origin: 'staff',
      amountPaise: 118_000,
      paidPaise: 0,
      status: 'created',
      provider: 'log',
      description: `${ok(await api(t, b.owner).get('/auth/me')).json<AuthProfile>().organization.name}: Invoice ${invoice.number}`,
      createdBy: 'Owner',
      paidAt: null,
      cancelledAt: null,
      documents: [
        {
          documentId: invoice.id,
          partyLedgerId: null,
          number: invoice.number,
          outstandingPaise: 118_000,
        },
      ],
      payments: [],
      refunds: [],
      refundedPaise: 0,
      refundPendingPaise: 0,
      refundFailed: false,
    });
    expect(result.link.url).toMatch(/^https:\/\/app\.example\.in\/pay\/plink_log_[\w-]{22}$/);
    // Payable for the business's 10 minutes ([PO-41]).
    const life = Date.parse(result.link.expiresAt) - Date.parse(result.link.createdAt);
    expect(life).toBe(10 * 60_000);
    expect(result.message).toBeNull();
    expect(decodeURIComponent(String(result.waMeUrl))).toContain(
      `Invoice ${invoice.number} for ₹1,180.00. Pay by UPI: ${result.link.url}`,
    );
    expect(provider().created.at(-1)).toMatchObject({
      reference: result.link.number,
      amountPaise: 118_000,
      customer: { name: 'Lakshmi Traders' },
    });
  });

  it('asks for the overdue bills oldest first, everything owed, or an advance', async () => {
    const party = await customer();
    const old = await bill(party, 2, await dbToday(t, -40));
    const late = await bill(party, 3, await dbToday(t, -5));
    await bill(party, 4, await dbToday(t, 10));

    const overdue = await created({ partyId: party, purpose: 'overdue' });
    expect(overdue.link.amountPaise).toBe(59_000);
    expect(overdue.link.documents.map((d) => d.documentId)).toEqual([old.id, late.id]);
    expect(decodeURIComponent(String(overdue.waMeUrl))).toContain(
      'is overdue by 40 days. Please pay at the earliest. Pay by UPI:',
    );

    const all = await created({ partyId: party, purpose: 'outstanding', amountPaise: 50_000 });
    expect(all.link).toMatchObject({ amountPaise: 50_000, purpose: 'outstanding' });
    expect(all.link.documents).toHaveLength(3);
    expect(decodeURIComponent(String(all.waMeUrl))).toContain('requests a payment of ₹500.00');

    const advance = await created({ partyId: party, purpose: 'advance', amountPaise: 999_999 });
    expect(advance.link).toMatchObject({ amountPaise: 999_999, documents: [] });
  });

  it('refuses what cannot be asked for', async () => {
    const party = await customer();
    const paid = await bill(party, 1);
    ok(
      await api(t, b.owner).post('/payments', {
        storeId: b.stores.amp,
        partyId: party,
        modeId: b.modes.upi.id,
        amountPaise: 11_800,
      }),
    );
    const conflict = async (body: object, code: string) => {
      const reply = await create(body);
      expect(reply.statusCode).toBe(409);
      expect(reply.json<{ code: string }>().code).toBe(code);
    };
    await conflict({ partyId: party, purpose: 'invoice', invoiceId: paid.id }, 'link_not_open');
    await conflict({ partyId: party, purpose: 'overdue' }, 'link_nothing_due');
    await conflict({ partyId: party, purpose: 'outstanding' }, 'link_nothing_due');

    const owing = await customer();
    const open = await bill(owing, 1);
    await conflict(
      { partyId: owing, purpose: 'outstanding', amountPaise: 11_801 },
      'link_over_due',
    );
    // An advance as big as the bill: allocate it instead.
    ok(
      await api(t, b.owner).post('/payments', {
        storeId: b.stores.amp,
        partyId: owing,
        modeId: b.modes.upi.id,
        amountPaise: 11_800,
        allocations: [],
      }),
    );
    await conflict(
      { partyId: owing, purpose: 'invoice', invoiceId: open.id },
      'link_covered_by_advance',
    );

    const other = await customer();
    expect(
      issuesOf(await create({ partyId: other, purpose: 'invoice', invoiceId: open.id })),
    ).toEqual(['invoiceId']);
    expect(issuesOf(await create({ partyId: other, purpose: 'advance' }))).toEqual(['amountPaise']);
    expect(
      issuesOf(await create({ partyId: other, purpose: 'outstanding', invoiceId: open.id })),
    ).toEqual(['invoiceId']);
    expect(
      issuesOf(await create({ partyId: other, purpose: 'advance', amountPaise: 100_000_001 })),
    ).toEqual(['amountPaise']);
    expect(
      (await create({ partyId: other, purpose: 'invoice', invoiceId: crypto.randomUUID() }))
        .statusCode,
    ).toBe(404);
  });

  it('records a party-level link at the home store, or the store chosen', async () => {
    const homeless = await customer({ homeStoreId: undefined });
    await bill(homeless, 1, undefined, b.stores.kkp);
    expect(issuesOf(await create({ partyId: homeless, purpose: 'outstanding' }))).toEqual([
      'storeId',
    ]);
    const chosen = await created({
      partyId: homeless,
      purpose: 'outstanding',
      storeId: b.stores.kkp,
    });
    expect(chosen.link.storeId).toBe(b.stores.kkp);
    // No wa.me without a mobile.
    const noPhone = await customer({ phone: undefined });
    await bill(noPhone, 1);
    expect((await created({ partyId: noPhone, purpose: 'outstanding' })).waMeUrl).toBeNull();
  });

  it('is for members who take payments, at their stores, for customers they see', async () => {
    const party = await customer();
    const invoice = await bill(party, 1);
    const employee = await b.member('store_employee', [b.stores.amp]);
    const kkpSales = await b.member('sales_executive', [b.stores.kkp]);
    const ampSales = await b.member('sales_executive', [b.stores.amp]);
    expect((await create({ partyId: party, purpose: 'outstanding' }, employee)).statusCode).toBe(
      403,
    );
    expect((await create({ partyId: party, purpose: 'outstanding' }, kkpSales)).statusCode).toBe(
      404,
    );
    const kkpInvoice = await bill(party, 1, undefined, b.stores.kkp);
    expect(
      (await create({ partyId: party, purpose: 'invoice', invoiceId: kkpInvoice.id }, ampSales))
        .statusCode,
    ).toBe(404);
    expect(
      (await create({ partyId: party, purpose: 'outstanding', storeId: b.stores.kkp }, ampSales))
        .statusCode,
    ).toBe(403);
    const mine = await created(
      { partyId: party, purpose: 'invoice', invoiceId: invoice.id },
      ampSales,
    );
    expect(mine.link.createdBy).toBe('Staff sales_executive');
    // Links at another store are not theirs to see.
    const kkpLink = await created({ partyId: party, purpose: 'invoice', invoiceId: kkpInvoice.id });
    expect((await api(t, ampSales).get(`/payment-links/${kkpLink.link.id}`)).statusCode).toBe(404);
    const page = ok(
      await api(t, ampSales).get(`/payment-links?partyId=${party}`),
    ).json<PaymentLinkPage>();
    expect(page.items.map((item) => item.id)).toEqual([mine.link.id]);
    expect(
      ok(await api(t, employee).get(`/payment-links?partyId=${party}`)).json<PaymentLinkPage>()
        .total,
    ).toBe(1);
  });

  it('refuses walk-in customers, and works only when links are set up', async () => {
    const walkIn = await b.draft({
      storeId: b.stores.amp,
      lines: [{ variantId: b.apex, quantity: 1 }],
    });
    ok(
      await api(t, b.owner).post(`/invoices/${walkIn.id}/issue`, {
        payments: [{ modeId: b.modes.upi.id, amountPaise: 11_800 }],
      }),
    );
    const [settings] = await t.connection.db
      .select({ walkIn: schema.salesSettings.walkInPartyId })
      .from(schema.salesSettings)
      .where(eq(schema.salesSettings.organizationId, b.organizationId));
    expect(
      issuesOf(
        await create({ partyId: String(settings?.walkIn), purpose: 'advance', amountPaise: 100 }),
      ),
    ).toEqual(['partyId']);
    const party = await customer();
    const reply = await create(
      { partyId: party, purpose: 'advance', amountPaise: 100 },
      b.owner,
      off,
    );
    expect(reply.statusCode).toBe(409);
    expect(reply.json<{ code: string }>().code).toBe('payment_links_off');
  });

  it('queues the WhatsApp message with the link when the party agreed', async () => {
    const party = await customer();
    const invoice = await bill(party, 2);
    const unasked = await created({
      partyId: party,
      purpose: 'invoice',
      invoiceId: invoice.id,
      send: 'whatsapp',
    });
    expect(unasked.message).toEqual({ queued: false, reason: 'no_consent' });

    await grantWhatsapp(party, 'hi');
    const sent = await created({
      partyId: party,
      purpose: 'invoice',
      invoiceId: invoice.id,
      send: 'whatsapp',
    });
    expect(sent.message).toMatchObject({ queued: true });
    const [message] = await t.connection.db
      .select()
      .from(messageOutbox)
      .where(eq(messageOutbox.referenceId, sent.link.id));
    expect(message).toMatchObject({
      templateKey: 'invoice_issued',
      language: 'hi',
      referenceType: 'payment_link',
      dedupeKey: `payment_link:${sent.link.id}`,
    });
    expect(message?.body).toContain(`UPI से भुगतान करें: ${sent.link.url}`);
    // wa.me speaks the party's language too.
    expect(decodeURIComponent(String(sent.waMeUrl))).toContain('UPI से भुगतान करें');

    const noWhatsapp = await create(
      { partyId: party, purpose: 'invoice', invoiceId: invoice.id, send: 'whatsapp' },
      b.owner,
      quiet,
    );
    expect(noWhatsapp.statusCode).toBe(409);
    expect(noWhatsapp.json<{ code: string }>().code).toBe('whatsapp_off');
    const shared = ok(
      await create({ partyId: party, purpose: 'invoice', invoiceId: invoice.id }, b.owner, quiet),
    ).json<PaymentLinkCreated>();
    expect(shared.message).toBeNull();
  });

  it('is made once per Idempotency-Key', async () => {
    const party = await customer();
    const invoice = await bill(party, 1);
    const once = (key: string) =>
      api(t, b.owner, { 'idempotency-key': key }).post('/payment-links', {
        partyId: party,
        purpose: 'invoice',
        invoiceId: invoice.id,
      });
    const first = ok(await once('link-key-1')).json<PaymentLinkCreated>();
    const again = ok(await once('link-key-1')).json<PaymentLinkCreated>();
    expect(again.link.id).toBe(first.link.id);
  });
});

describe('a payment reported by the gateway', () => {
  it('is recorded at the link’s store, allocated, receipted and told, with no one entering it', async () => {
    const party = await customer({ displayName: 'Ravi Painters' });
    await grantWhatsapp(party);
    const invoice = await bill(party, 10);
    const { link } = await created({ partyId: party, purpose: 'invoice', invoiceId: invoice.id });

    const { outcome } = await payLink(link, 118_000, {
      paymentId: 'pay_log_ravi_1',
      paidAt: new Date('2026-01-01T20:00:00Z'),
    });

    expect(outcome).toBe('applied');
    const [payment] = await paymentsOf(link.id);
    expect(payment).toMatchObject({
      storeId: b.stores.amp,
      partyId: party,
      direction: 'in',
      modeKind: 'upi_link',
      amountPaise: 118_000,
      // 20:00 UTC is the next morning in India.
      receivedOn: '2026-01-02',
      gatewayReference: 'pay_log_ravi_1',
      reference: 'pay_log_ravi_1',
      registerSessionId: null,
      createdByMemberId: null,
      voucherNumber: null,
      note: `Paid by UPI link ${link.number}`,
    });
    const shown = ok(
      await api(t, b.owner).get(`/payments/${String(payment?.id)}`),
    ).json<PaymentView>();
    expect(shown).toMatchObject({
      mode: { kind: 'upi_link', name: 'UPI link' },
      unallocatedPaise: 0,
      paymentLinkId: link.id,
      createdByMemberId: null,
      allocations: [{ documentId: invoice.id, amountPaise: 118_000 }],
    });
    const receipt = ok(
      await api(t, b.owner).get(`/payments/${String(payment?.id)}/receipt`),
    ).json<ReceiptView>();
    expect(receipt).toMatchObject({ receivedBy: null, settled: [{ number: invoice.number }] });

    expect(await view(link.id)).toMatchObject({
      status: 'paid',
      paidPaise: 118_000,
      paidAt: expect.any(String) as string,
      payments: [
        {
          id: payment?.id,
          number: payment?.number,
          amountPaise: 118_000,
          receivedOn: '2026-01-02',
          advancePaise: 0,
        },
      ],
    });
    expect(await balanceOf(party)).toEqual({ balance: 0, advance: 0 });
    await booksBalance();
    expect(await noticesOf('Paid by UPI link: Ravi Painters')).toEqual([
      {
        title: 'Paid by UPI link: Ravi Painters',
        body: `₹1,180.00 received for ${link.number}, recorded as ${String(payment?.number)}.`,
        link: `/payments/${String(payment?.id)}`,
      },
    ]);
    const [receiptMessage] = await t.connection.db
      .select({ templateKey: messageOutbox.templateKey, body: messageOutbox.body })
      .from(messageOutbox)
      .where(eq(messageOutbox.referenceId, String(payment?.id)));
    expect(receiptMessage).toEqual({
      templateKey: 'receipt_issued',
      body: `Dear Ravi Painters, ${ok(await api(t, b.owner).get('/auth/me')).json<AuthProfile>().organization.name} has received ₹1,180.00 (receipt ${String(payment?.number)}). Thank you.`,
    });
    // The event is kept against the business.
    const [stored] = await t.connection.db
      .select()
      .from(paymentGatewayEvents)
      .where(eq(paymentGatewayEvents.objectId, referenceOf(link)));
    expect(stored).toMatchObject({
      gateway: 'log',
      type: 'payment.captured',
      organizationId: b.organizationId,
    });
  });

  it('changes nothing when the same webhook comes again, or the same payment in another event', async () => {
    const party = await customer();
    const invoice = await bill(party, 1);
    const { link } = await created({ partyId: party, purpose: 'invoice', invoiceId: invoice.id });
    const first = await payLink(link, 11_800, { paymentId: 'pay_log_once' });
    expect(first.outcome).toBe('applied');

    const replay = ok(await deliver(first.webhook.body, first.webhook.signature)).json<{
      received: string;
    }>();
    expect(replay.received).toBe('duplicate');
    const sameMoney = await payLink(link, 11_800, { paymentId: 'pay_log_once' });
    expect(sameMoney.outcome).toBe('ignored');

    expect(await paymentsOf(link.id)).toHaveLength(1);
    expect(await view(link.id)).toMatchObject({ status: 'paid', paidPaise: 11_800 });
    expect(await balanceOf(party)).toEqual({ balance: 0, advance: 0 });
  });

  it('keeps a part payment open, and pays the link when the rest comes', async () => {
    const party = await customer();
    const invoice = await bill(party, 5);
    const { link } = await created({ partyId: party, purpose: 'invoice', invoiceId: invoice.id });

    await payLink(link, 20_000);
    expect(await view(link.id)).toMatchObject({
      status: 'created',
      paidPaise: 20_000,
      paidAt: null,
    });
    expect(await balanceOf(party)).toEqual({ balance: 39_000, advance: 0 });

    await payLink(link, 39_000);
    expect(await view(link.id)).toMatchObject({ status: 'paid', paidPaise: 59_000 });
    expect(await balanceOf(party)).toEqual({ balance: 0, advance: 0 });
    await booksBalance();
  });

  it('refunds an overpayment through the gateway, with a refund voucher, and says so', async () => {
    const party = await customer({ displayName: 'Over Payer' });
    const invoice = await bill(party, 1);
    const { link } = await created({ partyId: party, purpose: 'invoice', invoiceId: invoice.id });

    await payLink(link, 20_000);

    const [payment, refund] = await paymentsOf(link.id);
    expect(payment?.voucherNumber).toEqual(expect.any(String));
    expect(refund).toMatchObject({ direction: 'out', amountPaise: 8_200 });
    expect(refund?.voucherNumber).toEqual(expect.any(String));
    expect(await balanceOf(party)).toEqual({ balance: 0, advance: 0 });
    expect(await view(link.id)).toMatchObject({
      refundedPaise: 8_200,
      refundPendingPaise: 0,
      refunds: [{ amountPaise: 8_200, reason: 'overpaid', status: 'refunded' }],
    });
    expect(await noticesOf('Over Payer')).toEqual([
      expect.objectContaining({
        title: 'Paid by UPI link: Over Payer',
        body: expect.stringContaining(
          '₹82.00 was not owed and goes back to the customer through the gateway.',
        ) as string,
      }),
    ]);
    expect(await noticesOf('Over Payer', 'payment_link_refund')).toEqual([
      expect.objectContaining({
        title: 'Refunded through the gateway: Over Payer',
        body: expect.stringMatching(
          /^₹82\.00 paid by PL-\d{6} went back to the customer, as it was more than the bills owed: RF-\d{6}\.$/,
        ) as string,
      }),
    ]);
    await booksBalance();
  });

  it('keeps money for a bill already paid some other way as an advance, and tells staff', async () => {
    const party = await customer({ displayName: 'Paid Twice' });
    const invoice = await bill(party, 1);
    const { link } = await created({ partyId: party, purpose: 'invoice', invoiceId: invoice.id });
    ok(
      await api(t, b.owner).post('/payments', {
        storeId: b.stores.amp,
        partyId: party,
        modeId: b.modes.upi.id,
        amountPaise: 11_800,
      }),
    ).json<PaymentView>();

    await payLink(link, 11_800);

    expect(await balanceOf(party)).toEqual({ balance: 0, advance: 0 });
    expect(await noticesOf('Paid Twice')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'UPI link paid for bills already settled: Paid Twice',
          body: expect.stringContaining('₹118.00 was not owed and goes back') as string,
        }),
      ]),
    );
    expect((await view(link.id)).refunds).toMatchObject([
      { amountPaise: 11_800, reason: 'settled', status: 'refunded' },
    ]);
    await booksBalance();
  });

  it('pays a party-level link’s opening balance and bills oldest first; an advance link pays nothing', async () => {
    const party = await customer();
    // An opening balance brought in at go-live, as the import writes it.
    await withTenant(t.connection.db, b.organizationId, (tx) =>
      postPartyLedger(tx, [
        {
          organizationId: b.organizationId,
          partyId: party,
          entryOn: '2026-04-01',
          entryType: 'opening',
          amountPaise: 1_000,
          note: 'Opening balance',
        },
      ]),
    );
    const everything = await created({ partyId: party, purpose: 'outstanding' });
    expect(everything.link.documents).toEqual([
      {
        documentId: null,
        partyLedgerId: expect.any(String) as string,
        number: 'Opening balance',
        outstandingPaise: 1_000,
      },
    ]);
    await payLink(everything.link, 1_000);
    expect((await view(everything.link.id)).status).toBe('paid');
    const old = await bill(party, 1, await dbToday(t, -30));
    const newer = await bill(party, 2, await dbToday(t, -2));
    const { link } = await created({ partyId: party, purpose: 'overdue' });

    await payLink(link, 20_000);

    const [payment] = await paymentsOf(link.id);
    const shown = ok(
      await api(t, b.owner).get(`/payments/${String(payment?.id)}`),
    ).json<PaymentView>();
    expect(shown.allocations.map((a) => [a.documentId, a.amountPaise])).toEqual([
      [old.id, 11_800],
      [newer.id, 8_200],
    ]);

    const advance = await created({ partyId: party, purpose: 'advance', amountPaise: 5_000 });
    await payLink(advance.link, 5_000);
    expect((await view(advance.link.id)).payments).toMatchObject([{ advancePaise: 5_000 }]);
    await booksBalance();
  });

  it('is recorded after the link expired or was cancelled', async () => {
    const party = await customer();
    const invoice = await bill(party, 1);
    const expiring = await created({ partyId: party, purpose: 'invoice', invoiceId: invoice.id });
    expect(await linkEvent(expiring.link, 'link.expired')).toBe('applied');
    expect((await view(expiring.link.id)).status).toBe('expired');
    await payLink(expiring.link, 5_000);
    expect(await view(expiring.link.id)).toMatchObject({ status: 'expired', paidPaise: 5_000 });
    await payLink(expiring.link, 6_800);
    expect(await view(expiring.link.id)).toMatchObject({ status: 'paid', paidPaise: 11_800 });

    const second = await bill(party, 1);
    const cancelled = await created({ partyId: party, purpose: 'invoice', invoiceId: second.id });
    const reply = ok(
      await api(t, b.owner).post(`/payment-links/${cancelled.link.id}/cancel`),
    ).json<PaymentLinkView>();
    expect(reply).toMatchObject({ status: 'cancelled', cancelledAt: expect.any(String) as string });
    expect(provider().cancelled).toContain(referenceOf(cancelled.link));
    await payLink(cancelled.link, 11_800);
    expect(await view(cancelled.link.id)).toMatchObject({ status: 'paid', paidPaise: 11_800 });
    await booksBalance();
  });

  it('applies events in any order: a late expiry never undoes a payment', async () => {
    const party = await customer();
    const invoice = await bill(party, 1);
    const { link } = await created({ partyId: party, purpose: 'invoice', invoiceId: invoice.id });
    await payLink(link, 11_800);
    expect(await linkEvent(link, 'link.expired')).toBe('ignored');
    expect(await linkEvent(link, 'link.cancelled')).toBe('ignored');
    expect((await view(link.id)).status).toBe('paid');

    const open = await created({ partyId: party, purpose: 'advance', amountPaise: 100 });
    expect(await linkEvent(open.link, 'link.cancelled')).toBe('applied');
    expect(await view(open.link.id)).toMatchObject({
      status: 'cancelled',
      cancelledAt: expect.any(String) as string,
    });
    expect(await linkEvent(open.link, 'link.expired')).toBe('ignored');
    expect(await linkEvent(open.link, 'payment_link.updated')).toBe('ignored');
  });

  it('records each of several payments arriving at once, and one of a repeated event', async () => {
    const party = await customer();
    const invoice = await bill(party, 10);
    const { link } = await created({ partyId: party, purpose: 'invoice', invoiceId: invoice.id });
    const replies = await Promise.all(
      [30_000, 40_000, 48_000].map((amountPaise) => payLink(link, amountPaise)),
    );
    expect(replies.map((reply) => reply.outcome)).toEqual(['applied', 'applied', 'applied']);
    expect(await view(link.id)).toMatchObject({ status: 'paid', paidPaise: 118_000 });

    const repeated = provider().webhook({
      type: 'payment.captured',
      linkId: referenceOf(link),
      payment: { amountPaise: 1_000 },
    });
    const outcomes = await Promise.all(
      [1, 2, 3].map(
        async () =>
          ok(await deliver(repeated.body, repeated.signature)).json<{ received: string }>()
            .received,
      ),
    );
    expect(outcomes.sort()).toEqual(['applied', 'duplicate', 'duplicate']);
    // Three payments in, the late one in and refunded once through the gateway ([PO-44]).
    const recorded = await paymentsOf(link.id);
    expect(recorded.map((payment) => payment.direction).sort()).toEqual([
      'in',
      'in',
      'in',
      'in',
      'out',
    ]);
    expect((await view(link.id)).refunds).toMatchObject([
      { amountPaise: 1_000, reason: 'settled', status: 'refunded' },
    ]);
    expect(await balanceOf(party)).toEqual({ balance: 0, advance: 0 });
    await booksBalance();
  });

  it('believes nothing unsigned, answers only on the configured provider, and ignores unknown links', async () => {
    const forged = await deliver(Buffer.from('{"id":"evt_x"}'), 'forged');
    expect(forged.statusCode).toBe(400);
    const empty = await t.app.inject({ method: 'POST', url: '/webhooks/payment-links/log' });
    expect(empty.statusCode).toBe(400);
    const unknownLink = provider().webhook({
      type: 'payment.captured',
      linkId: 'plink_log_aaaaaaaaaaaaaaaaaaaaaa',
      payment: { amountPaise: 100 },
    });
    expect(
      ok(await deliver(unknownLink.body, unknownLink.signature)).json<{ received: string }>()
        .received,
    ).toBe('ignored');
    expect(
      (
        await deliver(
          unknownLink.body,
          unknownLink.signature,
          t,
          '/webhooks/payment-links/razorpay',
        )
      ).statusCode,
    ).toBe(404);
    expect((await deliver(unknownLink.body, unknownLink.signature, off)).statusCode).toBe(404);
    expect(
      (
        await deliver(
          unknownLink.body,
          unknownLink.signature,
          off,
          '/webhooks/payment-links/disabled',
        )
      ).statusCode,
    ).toBe(404);
    // The log gateway names no business in its route.
    expect(
      (
        await deliver(
          unknownLink.body,
          unknownLink.signature,
          t,
          '/webhooks/payment-links/log/aaaaaaaaaaaaaaaaaaaaaa',
        )
      ).statusCode,
    ).toBe(404);
    // Another process's log provider signs with another secret.
    expect((await deliver(unknownLink.body, unknownLink.signature, quiet)).statusCode).toBe(400);
  });
});

describe('payment link lists and cancelling', () => {
  it('lists links newest first by party, invoice, store and status as shown', async () => {
    const party = await customer();
    const invoice = await bill(party, 1);
    const first = await created({ partyId: party, purpose: 'invoice', invoiceId: invoice.id });
    const second = await created({ partyId: party, purpose: 'advance', amountPaise: 500 });
    await payLink(second.link, 500);
    const list = async (query: string) =>
      ok(await api(t, b.owner).get(`/payment-links?${query}`)).json<PaymentLinkPage>();

    expect((await list(`partyId=${party}`)).items.map((item) => item.id)).toEqual([
      second.link.id,
      first.link.id,
    ]);
    expect((await list(`invoiceId=${invoice.id}`)).items.map((item) => item.id)).toEqual([
      first.link.id,
    ]);
    expect((await list(`partyId=${party}&status=paid`)).total).toBe(1);
    expect((await list(`partyId=${party}&status=created`)).items[0]).toMatchObject({
      id: first.link.id,
      partyName: expect.any(String) as string,
    });
    expect((await list(`partyId=${party}&storeId=${b.stores.kkp}`)).total).toBe(0);
    expect((await list(`partyId=${party}&limit=1&offset=1`)).items.map((i) => i.id)).toEqual([
      first.link.id,
    ]);
    expect((await api(t, b.owner).get('/payment-links?status=lost')).statusCode).toBe(400);
  });

  it('cancels an open link once, at a store the member works at', async () => {
    const party = await customer();
    const { link } = await created({ partyId: party, purpose: 'advance', amountPaise: 700 });
    const kkpSales = await b.member('sales_executive', [b.stores.kkp]);
    expect((await api(t, kkpSales).post(`/payment-links/${link.id}/cancel`)).statusCode).toBe(404);
    ok(await api(t, b.owner).post(`/payment-links/${link.id}/cancel`));
    const again = await api(t, b.owner).post(`/payment-links/${link.id}/cancel`);
    expect(again.statusCode).toBe(409);
    expect(again.json<{ message: string }>().message).toBe('This link is already cancelled');
    expect(
      (await api(t, b.owner).post(`/payment-links/${crypto.randomUUID()}/cancel`)).statusCode,
    ).toBe(404);
    expect((await api(t, b.owner).get(`/payment-links/${crypto.randomUUID()}`)).statusCode).toBe(
      404,
    );
    // A link made when links were on still cancels with them off; the gateway is not asked.
    const other = await created({ partyId: party, purpose: 'advance', amountPaise: 800 });
    const cancelledBefore = provider().cancelled.length;
    ok(await api(off, b.owner).post(`/payment-links/${other.link.id}/cancel`));
    expect(provider().cancelled).toHaveLength(cancelledBefore);
  });
});

describe('the log provider’s checkout page', () => {
  it('shows the link and signs a webhook that records the payment once', async () => {
    const party = await customer({ displayName: 'Checkout Customer' });
    const invoice = await bill(party, 1);
    const { link } = await created({ partyId: party, purpose: 'invoice', invoiceId: invoice.id });
    const reference = referenceOf(link);
    const page = await t.app.inject({
      method: 'GET',
      url: `/public/payment-links/log/${reference}`,
    });
    expect(page.json<LogCheckoutView>()).toMatchObject({
      reference,
      partyName: 'Checkout Customer',
      number: link.number,
      amountPaise: 11_800,
      paidPaise: 0,
      status: 'created',
    });

    const part = ok(
      await t.app.inject({
        method: 'POST',
        url: `/public/payment-links/log/${reference}/pay`,
        payload: { amountPaise: 1_800 },
      }),
    ).json<LogWebhook>();
    expect(part).toMatchObject({
      path: '/webhooks/payment-links/log',
      header: LOG_SIGNATURE_HEADER,
    });
    const post = (webhook: LogWebhook) =>
      t.app.inject({
        method: 'POST',
        url: webhook.path,
        headers: { 'content-type': 'application/json', [webhook.header]: webhook.signature },
        payload: webhook.body,
      });
    expect(ok(await post(part)).json<{ received: string }>().received).toBe('applied');
    expect(ok(await post(part)).json<{ received: string }>().received).toBe('duplicate');

    // Left out, the amount is what is left; once paid, the whole amount again.
    const rest = ok(
      await t.app.inject({ method: 'POST', url: `/public/payment-links/log/${reference}/pay` }),
    ).json<LogWebhook>();
    expect(JSON.parse(rest.body)).toMatchObject({ payment: { amountPaise: 10_000 } });
    ok(await post(rest));
    const again = ok(
      await t.app.inject({ method: 'POST', url: `/public/payment-links/log/${reference}/pay` }),
    ).json<LogWebhook>();
    expect(JSON.parse(again.body)).toMatchObject({ payment: { amountPaise: 11_800 } });
  });

  it('is not found for a bad or unknown reference, or without the log provider', async () => {
    const get = (app: TestApp, reference: string) =>
      app.app.inject({ method: 'GET', url: `/public/payment-links/log/${reference}` });
    expect((await get(t, 'nope')).statusCode).toBe(404);
    expect((await get(t, 'plink_log_aaaaaaaaaaaaaaaaaaaaaa')).statusCode).toBe(404);
    expect((await get(off, 'plink_log_aaaaaaaaaaaaaaaaaaaaaa')).statusCode).toBe(404);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/public/payment-links/log/plink_log_aaaaaaaaaaaaaaaaaaaaaa/pay',
          payload: { amountPaise: 0 },
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('the UPI link payment mode', () => {
  it('is made by the system, and members never take money by it', async () => {
    const modes = ok(await api(t, b.owner).get('/payment-modes')).json<
      { id: string; kind: string; name: string }[]
    >();
    const link = modes.find((mode) => mode.kind === 'upi_link');
    expect(link?.name).toBe('UPI link');
    const party = await customer();
    expect(
      issuesOf(
        await api(t, b.owner).post('/payments', {
          storeId: b.stores.amp,
          partyId: party,
          modeId: link?.id,
          amountPaise: 100,
        }),
      ),
    ).toEqual(['modeId']);
    expect(
      issuesOf(await api(t, b.owner).post('/payment-modes', { kind: 'upi_link', name: 'Gateway' })),
    ).toEqual(['kind']);
  });

  it('takes another name when the business already uses "UPI link" for another mode', async () => {
    const other = await billingBusiness(t);
    ok(await api(t, other.owner).post('/payment-modes', { kind: 'other', name: 'UPI link' }));
    const party = ok(
      await api(t, other.owner).post('/parties', { displayName: 'Named', roles: ['customer'] }),
    ).json<{ id: string }>().id;
    const { link } = ok(
      await api(t, other.owner).post('/payment-links', {
        partyId: party,
        purpose: 'advance',
        amountPaise: 100,
        storeId: other.stores.amp,
      }),
    ).json<PaymentLinkCreated>();
    await payLink(link, 100);
    const [payment] = await paymentsOf(link.id);
    const shown = ok(
      await api(t, other.owner).get(`/payments/${String(payment?.id)}`),
    ).json<PaymentView>();
    expect(shown.mode.name).toBe('UPI payment link (gateway)');
    // A second payment uses the same mode.
    const second = ok(
      await api(t, other.owner).post('/payment-links', {
        partyId: party,
        purpose: 'advance',
        amountPaise: 200,
        storeId: other.stores.amp,
      }),
    ).json<PaymentLinkCreated>();
    await payLink(second.link, 200);
    const [next] = await paymentsOf(second.link.id);
    expect(next?.modeId).toBe(payment?.modeId);
  });
});

describe('payment links and party merges', () => {
  it('refuse to merge away a party asked for money by link', async () => {
    const party = await customer();
    const keep = await customer();
    await created({ partyId: party, purpose: 'advance', amountPaise: 100 });
    const reply = await api(t, b.owner).post(`/parties/${party}/merge`, { intoPartyId: keep });
    expect(reply.statusCode).toBe(409);
    expect(reply.json<{ message: string }>().message).toBe(
      'This party has payment links; merge the other way',
    );
    const rows = await t.connection.db
      .select({ id: paymentLinks.id })
      .from(paymentLinks)
      .where(eq(paymentLinks.partyId, party));
    expect(rows).toHaveLength(1);
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('link payments in the day’s books', () => {
  it('go to Tally as receipts into the gateway clearing ledger, and never into a register', async () => {
    const shop = await billingBusiness(t);
    const party = ok(
      await api(t, shop.owner).post('/parties', {
        displayName: 'Tally Customer',
        roles: ['customer'],
        homeStoreId: shop.stores.amp,
      }),
    ).json<{ id: string }>().id;
    const invoice = await shop.invoice({ partyId: party, quantity: 2 });
    const { link } = ok(
      await api(t, shop.owner).post('/payment-links', {
        partyId: party,
        purpose: 'invoice',
        invoiceId: invoice.id,
      }),
    ).json<PaymentLinkCreated>();
    // A register open at the store takes no part in it.
    const session = ok(
      await api(t, shop.owner).post('/registers/COUNTER1/open', {
        storeId: shop.stores.amp,
        openingFloatPaise: 0,
      }),
    ).json<{ id: string }>();
    await payLink(link, 23_600);

    const [payment] = await paymentsOf(link.id);
    expect(payment?.registerSessionId).toBeNull();
    const xml = ok(
      await api(t, shop.owner).post('/accounting-exports', {
        from: today,
        to: today,
        kinds: ['receipt'],
        format: 'tally_xml',
      }),
    ).body;
    expect(xml).toContain('Payment Gateway Clearing');
    expect(xml).toContain(String(payment?.number));
    const drawer = ok(await api(t, shop.owner).get(`/register-sessions/${session.id}`)).json<{
      cashInPaise: number;
      modeTotals: unknown[];
    }>();
    expect(drawer).toMatchObject({ cashInPaise: 0, modeTotals: [] });
  });
});
