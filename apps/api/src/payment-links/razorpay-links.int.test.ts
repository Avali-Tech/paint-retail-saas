import { migrateDatabase, schema } from '@paint/db';
import type {
  GatewayAccountView,
  GatewayTestResult,
  PaymentLinkCreated,
  PaymentLinkSettings,
  PaymentLinkView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import {
  api,
  billingBusiness,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { FakeRazorpay } from '../test-support/fake-razorpay.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

// Each business's own Razorpay account ([PO-40]) through the real adapter, against a
// fake Razorpay (no network) and a real database: connecting, the settings, links,
// webhooks on the business's own route, and refunds. Secrets never come back out.

const { auditLog, paymentGatewayAccounts, paymentLinkRefunds, paymentLinks, payments } = schema;

const KEY = Buffer.alloc(32, 3).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 4).toString('base64');

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
const razorpay = new FakeRazorpay();
const keys = razorpay.account();
/** Everything the API wrote to its logs while these tests ran. */
const logged: string[] = [];

const settingsOf = async (token = b.owner, app = t) =>
  ok(await api(app, token).get('/payment-links/settings')).json<PaymentLinkSettings>();
const accountOf = async (token = b.owner, app = t) =>
  ok(await api(app, token).get('/payment-links/gateway-account')).json<GatewayAccountView>();
const connect = (body: object, token = b.owner, app = t) =>
  api(app, token).put('/payment-links/gateway-account', body);

async function customer(): Promise<string> {
  return ok(
    await api(t, b.owner).post('/parties', {
      displayName: `Customer ${uniquePhone()}`,
      phone: uniquePhone(),
      roles: ['customer'],
      homeStoreId: b.stores.amp,
    }),
  ).json<{ id: string }>().id;
}

async function invoiceLink(business = b, app = t) {
  const party = ok(
    await api(app, business.owner).post('/parties', {
      displayName: `Customer ${uniquePhone()}`,
      roles: ['customer'],
      homeStoreId: business.stores.amp,
    }),
  ).json<{ id: string }>().id;
  const invoice = await business.invoice({ partyId: party, quantity: 1 });
  const reply = await api(app, business.owner).post('/payment-links', {
    partyId: party,
    purpose: 'invoice',
    invoiceId: invoice.id,
  });
  return { party, invoice, reply };
}

/** Razorpay's payment_link.paid event, signed with `secret`, posted to a business's route. */
function paidEvent(link: { gatewayLinkId: string }, amountPaise: number, paymentId: string) {
  return Buffer.from(
    JSON.stringify({
      entity: 'event',
      account_id: 'acc_test',
      event: 'payment_link.paid',
      contains: ['payment_link', 'order', 'payment'],
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment_link: {
          entity: { id: link.gatewayLinkId, amount: amountPaise, status: 'paid' },
        },
        payment: {
          entity: {
            id: paymentId,
            amount: amountPaise,
            status: 'captured',
            method: 'upi',
            created_at: Math.floor(Date.now() / 1000),
          },
        },
      },
    }),
  );
}

const post = (path: string, body: Buffer, signature: string, eventId?: string, app = t) =>
  app.app.inject({
    method: 'POST',
    url: path,
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': signature,
      ...(eventId === undefined ? {} : { 'x-razorpay-event-id': eventId }),
    },
    payload: body,
  });

const routeOf = (account: GatewayAccountView) =>
  new URL(account.webhookUrl).pathname.replace(/^\/api/, '');

beforeAll(async () => {
  const capture = (stream: NodeJS.WriteStream) =>
    vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    });
  capture(process.stdout);
  capture(process.stderr);
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(
    database.connectionString,
    {
      PAYMENT_LINK_PROVIDER: 'razorpay',
      GATEWAY_CREDENTIALS_KEY: KEY,
      PUBLIC_API_URL: 'https://api.example.in',
      LOG_LEVEL: 'verbose',
    },
    { gatewayFetch: razorpay.fetch },
  );
  b = await billingBusiness(t);
});

afterAll(async () => {
  await t.close();
  await database.stop();
  vi.restoreAllMocks();
});

describe('before a business connects Razorpay', () => {
  it('cannot make links, and has a webhook address ready to paste', async () => {
    expect(await settingsOf()).toEqual({
      provider: 'razorpay',
      ready: false,
      validityMinutes: 10,
      messageValidityMinutes: 1_440,
      minValidityMinutes: 5,
      capPaise: 10_000_000,
      amountBasis: 'net',
    });
    const account = await accountOf();
    expect(account).toEqual({
      gateway: 'razorpay',
      connected: false,
      live: null,
      keyIdHint: null,
      keySecretHint: null,
      webhookSecretHint: null,
      connectedAt: null,
      connectedBy: null,
      verifiedAt: null,
      webhookUrl: expect.stringMatching(
        /^https:\/\/api\.example\.in\/webhooks\/payment-links\/razorpay\/[\w-]{22}$/,
      ) as string,
      validityRaised: null,
    });
    // The address stays the same.
    expect((await accountOf()).webhookUrl).toBe(account.webhookUrl);
    const { reply } = await invoiceLink();
    expect(reply.statusCode).toBe(409);
    expect(reply.json<{ code: string }>().code).toBe('gateway_not_connected');
    const test = await api(t, b.owner).post('/payment-links/gateway-account/test');
    expect(test.json<{ code: string }>().code).toBe('gateway_not_connected');
    // Not yet connected, 10 minutes is still allowed; connecting raises it ([PO-60]).
    const saved = ok(
      await api(t, b.owner).put('/payment-links/settings', {
        validityMinutes: 10,
        messageValidityMinutes: 1_440,
        capPaise: 10_000_000,
        amountBasis: 'net',
      }),
    ).json<PaymentLinkSettings>();
    expect(saved).toMatchObject({ validityMinutes: 10, minValidityMinutes: 5 });
  });

  it('is managed by owners and admins only', async () => {
    const manager = await b.member('branch_manager', [b.stores.amp]);
    for (const reply of [
      await api(t, manager).get('/payment-links/gateway-account'),
      await connect(keys, manager),
      await api(t, manager).post('/payment-links/gateway-account/test'),
      await api(t, manager).delete('/payment-links/gateway-account'),
      await api(t, manager).put('/payment-links/settings', {
        validityMinutes: 30,
        messageValidityMinutes: 30,
        capPaise: 100,
        amountBasis: 'net',
      }),
    ]) {
      expect(reply.statusCode).toBe(403);
    }
    // Everyone may read whether links can be made.
    expect((await settingsOf(manager)).provider).toBe('razorpay');
  });
});

describe('connecting Razorpay', () => {
  it('refuses keys Razorpay does not accept, and malformed ones, keeping nothing', async () => {
    const wrong = await connect({ ...keys, keySecret: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toEqual({
      statusCode: 409,
      code: 'gateway_rejected',
      message: 'Razorpay did not accept these keys: check the key id and key secret',
    });
    expect(wrong.body).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
    const malformed = await connect({ keyId: 'key', keySecret: 'short', webhookSecret: 'a b' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain('short');
    expect((await accountOf()).connected).toBe(false);
  });

  it('keeps the keys sealed and shows only their last four characters', async () => {
    const reply = await connect(keys);
    const account = ok(reply).json<GatewayAccountView>();
    expect(account).toMatchObject({
      connected: true,
      live: true,
      keyIdHint: keys.keyId.slice(-4),
      keySecretHint: keys.keySecret.slice(-4),
      webhookSecretHint: keys.webhookSecret.slice(-4),
      connectedBy: 'Owner',
      // Its 10-minute links were raised to Razorpay's 15 ([PO-60]); a day was long enough.
      validityRaised: { counterFrom: 10, messageFrom: null, to: 15 },
    });
    expect(account.verifiedAt).not.toBeNull();
    for (const text of [
      reply.body,
      (await api(t, b.owner).get('/payment-links/gateway-account')).body,
    ]) {
      expect(text).not.toContain(keys.keySecret);
      expect(text).not.toContain(keys.webhookSecret);
      expect(text).not.toContain(keys.keyId);
    }
    // At rest: sealed, none of the secrets readable.
    const [row] = await t.connection.db
      .select()
      .from(paymentGatewayAccounts)
      .where(eq(paymentGatewayAccounts.organizationId, b.organizationId));
    expect(row?.credentialsSealed).toMatch(/^v1:/);
    const stored = JSON.stringify(row);
    for (const secret of [keys.keySecret, keys.webhookSecret, keys.keyId]) {
      expect(stored).not.toContain(secret);
    }
    // The audit log says who connected, without a secret.
    const audit = await t.connection.db
      .select({ oldValues: auditLog.oldValues, newValues: auditLog.newValues })
      .from(auditLog)
      .where(
        sql`${auditLog.tableName} = 'payment_gateway_accounts' and ${auditLog.organizationId} = ${b.organizationId}`,
      );
    expect(audit.length).toBeGreaterThan(0);
    const audited = JSON.stringify(audit);
    expect(audited).toContain(keys.keyId.slice(-4));
    for (const secret of [keys.keySecret, keys.webhookSecret, keys.keySecret.slice(-4)]) {
      expect(audited).not.toContain(secret);
    }
    expect(await settingsOf()).toMatchObject({
      ready: true,
      validityMinutes: 15,
      messageValidityMinutes: 1_440,
      minValidityMinutes: 15,
    });
    // Connecting again finds nothing to raise.
    expect(ok(await connect(keys)).json<GatewayAccountView>().validityRaised).toBeNull();
    expect((await accountOf()).validityRaised).toBeNull();
  });

  it('says when Razorpay cannot be checked just now', async () => {
    razorpay.testAnswer = 'garbage';
    try {
      const reply = await api(t, b.owner).post('/payment-links/gateway-account/test');
      expect(reply.statusCode).toBe(409);
      expect(reply.json<{ message: string }>().message).toBe(
        'Razorpay could not be checked just now (error): try again',
      );
    } finally {
      razorpay.testAnswer = 'ok';
    }
  });

  it('tests the kept keys with a harmless call', async () => {
    const before = razorpay.requests.length;
    const result = ok(
      await api(t, b.owner).post('/payment-links/gateway-account/test'),
    ).json<GatewayTestResult>();
    expect(result).toEqual({ ok: true, verifiedAt: expect.any(String) as string });
    expect(razorpay.requests.slice(before)).toEqual([
      { method: 'GET', path: '/payments?count=1', keyId: keys.keyId, body: undefined },
    ]);
  });
});

describe('links through the business’s own Razorpay account', () => {
  let linkView: PaymentLinkView;
  let gatewayLinkId: string;

  it('are UPI links made with its keys, for its validity and within its cap', async () => {
    const { reply } = await invoiceLink();
    linkView = ok(reply).json<PaymentLinkCreated>().link;
    const made = razorpay.requests.filter((request) => request.path === '/payment_links').at(-1);
    expect(made).toMatchObject({
      method: 'POST',
      keyId: keys.keyId,
      body: { amount: 11_800, currency: 'INR', upi_link: true, accept_partial: false },
    });
    const [stored] = await t.connection.db
      .select({ reference: paymentLinks.gatewayReference })
      .from(paymentLinks)
      .where(eq(paymentLinks.id, linkView.id));
    gatewayLinkId = String(stored?.reference);
    expect(gatewayLinkId).toMatch(/^plink_/);
    expect(linkView).toMatchObject({ provider: 'razorpay', amountPaise: 11_800 });
    expect(linkView.url).toMatch(/^https:\/\/rzp\.io\/i\//);
    // Razorpay's 15-minute minimum, with the adapter's minute of margin; recorded as
    // Razorpay keeps it, so the two expiries agree ([PO-60]).
    const expireBy = (made?.body as { expire_by: number }).expire_by * 1000;
    expect(expireBy - Date.now()).toBeGreaterThan(15 * 60_000);
    expect(Date.parse(linkView.expiresAt)).toBe(expireBy);
  });

  it('are refused above the business’s cap, and follow its validity', async () => {
    const bad = await api(t, b.owner).put('/payment-links/settings', {
      validityMinutes: 4,
      messageValidityMinutes: 1_440,
      capPaise: 60_000_000,
      amountBasis: 'gross',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ issues: { path: string }[] }>().issues.map((issue) => issue.path)).toEqual([
      'validityMinutes',
      'capPaise',
      'amountBasis',
    ]);
    // With Razorpay connected, under 15 minutes is refused for either validity ([PO-60]).
    for (const [field, minutes] of [
      ['validityMinutes', { validityMinutes: 10, messageValidityMinutes: 1_440 }],
      ['messageValidityMinutes', { validityMinutes: 15, messageValidityMinutes: 14 }],
    ] as const) {
      const short = await api(t, b.owner).put('/payment-links/settings', {
        ...minutes,
        capPaise: 10_000,
        amountBasis: 'net',
      });
      expect(short.statusCode).toBe(400);
      expect(short.json<{ issues: { path: string; message: string }[] }>().issues).toEqual([
        {
          path: field,
          message: 'Razorpay keeps a link payable for at least 15 minutes: enter 15 or more',
        },
      ]);
    }
    const saved = ok(
      await api(t, b.owner).put('/payment-links/settings', {
        validityMinutes: 30,
        messageValidityMinutes: 120,
        capPaise: 10_000,
        amountBasis: 'full',
      }),
    ).json<PaymentLinkSettings>();
    expect(saved).toMatchObject({
      validityMinutes: 30,
      messageValidityMinutes: 120,
      capPaise: 10_000,
      amountBasis: 'full',
    });
    const { reply } = await invoiceLink();
    expect(reply.statusCode).toBe(409);
    expect(reply.json()).toMatchObject({
      code: 'link_over_limit',
      message:
        'A link asks for at most ₹100.00: ask for part of it, or change the limit in Settings',
    });
    const party = await customer();
    const invoice = await b.invoice({ partyId: party, quantity: 1 });
    const part = ok(
      await api(t, b.owner).post('/payment-links', {
        partyId: party,
        purpose: 'invoice',
        invoiceId: invoice.id,
        amountPaise: 10_000,
      }),
    ).json<PaymentLinkCreated>();
    // Razorpay keeps whole seconds: within a second of the business's 30 minutes.
    const life = Date.parse(part.link.expiresAt) - Date.parse(part.link.createdAt);
    expect(life).toBeGreaterThanOrEqual(30 * 60_000);
    expect(life).toBeLessThan(30 * 60_000 + 1_000);
    ok(
      await api(t, b.owner).put('/payment-links/settings', {
        validityMinutes: 15,
        messageValidityMinutes: 1_440,
        capPaise: 10_000_000,
        amountBasis: 'net',
      }),
    );
  });

  it('are paid by a webhook signed with the business’s secret on its own route', async () => {
    const account = await accountOf();
    const body = paidEvent({ gatewayLinkId }, 11_800, 'pay_RzpOwn00001');
    expect((await post(routeOf(account), body, 'forged')).statusCode).toBe(400);
    const signed = FakeRazorpay.sign(body, keys.webhookSecret);
    const reply = ok(await post(routeOf(account), body, signed, 'evt_rzp_1'));
    expect(reply.json()).toEqual({ received: 'applied' });
    expect(ok(await post(routeOf(account), body, signed, 'evt_rzp_1')).json()).toEqual({
      received: 'duplicate',
    });
    const view = ok(
      await api(t, b.owner).get(`/payment-links/${linkView.id}`),
    ).json<PaymentLinkView>();
    expect(view).toMatchObject({ status: 'paid', paidPaise: 11_800 });
    // News about nothing this product keeps (a payment outside any link) is kept and ignored.
    const news = Buffer.from(JSON.stringify({ event: 'payment.captured', created_at: 1 }));
    expect(
      ok(
        await post(
          routeOf(account),
          news,
          FakeRazorpay.sign(news, keys.webhookSecret),
          'evt_rzp_0',
        ),
      ).json(),
    ).toEqual({ received: 'ignored' });
    // Other routes: no business, an unknown business, the log gateway.
    expect((await post('/webhooks/payment-links/razorpay', body, signed)).statusCode).toBe(404);
    expect(
      (await post('/webhooks/payment-links/razorpay/aaaaaaaaaaaaaaaaaaaaaa', body, signed))
        .statusCode,
    ).toBe(404);
    expect((await post('/webhooks/payment-links/log', body, signed)).statusCode).toBe(404);
    expect(
      (
        await post(
          `/webhooks/payment-links/disabled/${routeOf(account).split('/').at(-1) ?? ''}`,
          body,
          signed,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('refund through the gateway what a settled link is paid again', async () => {
    const account = await accountOf();
    const body = paidEvent({ gatewayLinkId }, 11_800, 'pay_RzpTwice001');
    const reply = ok(
      await post(routeOf(account), body, FakeRazorpay.sign(body, keys.webhookSecret), 'evt_rzp_2'),
    );
    expect(reply.json()).toEqual({ received: 'applied' });
    const asked = razorpay.requests.filter(
      (request) => request.path === '/payments/pay_RzpTwice001/refund',
    );
    expect(asked).toHaveLength(1);
    const [refund] = await t.connection.db
      .select()
      .from(paymentLinkRefunds)
      .where(eq(paymentLinkRefunds.gatewayPaymentId, 'pay_RzpTwice001'));
    expect(asked[0]?.body).toEqual({
      amount: 11_800,
      speed: 'normal',
      receipt: refund?.id,
      notes: { link: linkView.number, reason: 'settled' },
    });
    expect(refund).toMatchObject({
      status: 'refunded',
      provider: 'razorpay',
      gatewayStatus: 'processed',
    });
    const [out] = await t.connection.db
      .select()
      .from(payments)
      .where(eq(payments.id, String(refund?.refundPaymentId)));
    expect(out).toMatchObject({
      direction: 'out',
      amountPaise: 11_800,
      gatewayReference: refund?.gatewayRefundId,
    });
    // Razorpay's later news: processed.
    const news = Buffer.from(
      JSON.stringify({
        event: 'refund.processed',
        created_at: 1,
        payload: {
          refund: {
            entity: {
              id: refund?.gatewayRefundId,
              payment_id: 'pay_RzpTwice001',
              amount: 11_800,
              status: 'processed',
            },
          },
        },
      }),
    );
    expect(
      ok(
        await post(
          routeOf(account),
          news,
          FakeRazorpay.sign(news, keys.webhookSecret),
          'evt_rzp_3',
        ),
      ).json(),
    ).toEqual({ received: 'ignored' });
  });

  it('never let another business’s secret speak for this business’s links', async () => {
    const other = await billingBusiness(t);
    const theirs = razorpay.account(false);
    // Its counter links already last 30 minutes; only its 5-minute message links are raised.
    ok(
      await api(t, other.owner).put('/payment-links/settings', {
        validityMinutes: 30,
        messageValidityMinutes: 5,
        capPaise: 10_000_000,
        amountBasis: 'net',
      }),
    );
    expect(
      ok(await connect(theirs, other.owner)).json<GatewayAccountView>().validityRaised,
    ).toEqual({ counterFrom: null, messageFrom: 5, to: 15 });
    const otherAccount = await accountOf(other.owner);
    expect(otherAccount.live).toBe(false);
    const body = paidEvent({ gatewayLinkId }, 11_800, 'pay_Forged00001');
    const reply = ok(
      await post(
        routeOf(otherAccount),
        body,
        FakeRazorpay.sign(body, theirs.webhookSecret),
        'evt_rzp_4',
      ),
    );
    expect(reply.json()).toEqual({ received: 'ignored' });
    const forged = await t.connection.db
      .select()
      .from(payments)
      .where(eq(payments.gatewayReference, 'pay_Forged00001'));
    expect(forged).toEqual([]);
    // Its own links are made with its own (test) keys, offering UPI on a standard link.
    const { reply: made } = await invoiceLink(other);
    ok(made);
    const request = razorpay.requests.filter((one) => one.path === '/payment_links').at(-1);
    expect(request).toMatchObject({ keyId: theirs.keyId });
    expect(request?.body).not.toHaveProperty('upi_link');
  });
});

describe('disconnecting Razorpay', () => {
  it('forgets the keys, keeps the webhook address, and refuses webhooks meanwhile', async () => {
    const before = await accountOf();
    const after = ok(
      await api(t, b.owner).delete('/payment-links/gateway-account'),
    ).json<GatewayAccountView>();
    expect(after).toMatchObject({
      connected: false,
      keyIdHint: null,
      keySecretHint: null,
      webhookSecretHint: null,
      webhookUrl: before.webhookUrl,
    });
    const [row] = await t.connection.db
      .select({ sealed: paymentGatewayAccounts.credentialsSealed })
      .from(paymentGatewayAccounts)
      .where(eq(paymentGatewayAccounts.organizationId, b.organizationId));
    expect(row?.sealed).toBeNull();
    const body = paidEvent({ gatewayLinkId: 'plink_x' }, 100, 'pay_After00001');
    expect(
      (await post(routeOf(after), body, FakeRazorpay.sign(body, keys.webhookSecret))).statusCode,
    ).toBe(404);
    expect((await settingsOf()).ready).toBe(false);
    // Reconnecting brings the same address back to life.
    ok(await connect(keys));
    expect((await accountOf()).webhookUrl).toBe(before.webhookUrl);
  });
});

describe('credentials the API cannot open', () => {
  it('make the business not ready, and are never logged', async () => {
    const rotated = await startTestApp(
      database.connectionString,
      {
        PAYMENT_LINK_PROVIDER: 'razorpay',
        GATEWAY_CREDENTIALS_KEY: OTHER_KEY,
        LOG_LEVEL: 'verbose',
      },
      { gatewayFetch: razorpay.fetch },
    );
    try {
      expect((await settingsOf(b.owner, rotated)).ready).toBe(false);
      const { reply } = await invoiceLink(b, rotated);
      expect(reply.json<{ code: string }>().code).toBe('gateway_not_connected');
      // Its webhooks cannot be checked either: refused, so Razorpay retries them later.
      const account = await accountOf(b.owner, rotated);
      const body = paidEvent({ gatewayLinkId: 'plink_x' }, 100, 'pay_Rotated0001');
      expect(
        (
          await post(
            routeOf(account),
            body,
            FakeRazorpay.sign(body, keys.webhookSecret),
            undefined,
            rotated,
          )
        ).statusCode,
      ).toBe(404);
      // A previous key that sealed them opens them again.
      const both = await startTestApp(
        database.connectionString,
        {
          PAYMENT_LINK_PROVIDER: 'razorpay',
          GATEWAY_CREDENTIALS_KEY: OTHER_KEY,
          GATEWAY_CREDENTIALS_PREVIOUS_KEY: KEY,
        },
        { gatewayFetch: razorpay.fetch },
      );
      expect((await settingsOf(b.owner, both)).ready).toBe(true);
      await both.close();
      // Opened once under the new key, they are sealed again with it: the old key can go.
      expect((await settingsOf(b.owner, rotated)).ready).toBe(true);
    } finally {
      await rotated.close();
    }
  });

  it('nothing the API logged carries a secret', () => {
    const text = logged.join('');
    expect(text).toContain('could not be opened');
    for (const secret of [keys.keySecret, keys.webhookSecret]) {
      expect(text).not.toContain(secret);
    }
  });
});
