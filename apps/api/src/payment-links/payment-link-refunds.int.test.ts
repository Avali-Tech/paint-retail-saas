import {
  findAllocationMismatches,
  findPartyBalanceMismatches,
  migrateDatabase,
  schema,
  withTenant,
} from '@paint/db';
import { MAX_REFUND_ATTEMPTS, type PaymentLinkCreated, type PaymentLinkView } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { Notifier } from '../notifications/notifier.js';
import { api, billingBusiness, dbToday, ok, type BillingBusiness } from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import { attemptLinkRefund, runDueLinkRefunds } from './link-refunds.js';
import { PAYMENT_LINK_GATEWAYS, type PaymentLinkGateways } from './payment-link-gateways.js';
import { LOG_SIGNATURE_HEADER, type LogPaymentLinkProvider } from './payment-link-provider.js';

// Refunds through the gateway of money a link took that nothing was owed for (spec
// §6.2 PL-15 – PL-18, [PO-44]), with the log gateway standing in for Razorpay.

const { notifications, partyBalances, paymentLinkRefunds, payments } = schema;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;

const gateways = () => t.app.get<PaymentLinkGateways>(PAYMENT_LINK_GATEWAYS, { strict: false });
const gateway = (): LogPaymentLinkProvider => {
  const log = gateways().log;
  if (log === null) throw new Error('No log gateway');
  return log;
};
const notifier = () => t.app.get(Notifier);
const referenceOf = (link: { url: string }) => String(link.url.split('/').at(-1));

const deliver = (webhook: { body: Buffer; signature: string }) =>
  t.app.inject({
    method: 'POST',
    url: '/webhooks/payment-links/log',
    headers: { 'content-type': 'application/json', [LOG_SIGNATURE_HEADER]: webhook.signature },
    payload: webhook.body,
  });
const received = async (webhook: { body: Buffer; signature: string }) =>
  ok(await deliver(webhook)).json<{ received: string }>().received;

async function customer(name: string): Promise<string> {
  return ok(
    await api(t, b.owner).post('/parties', {
      displayName: `${name} ${uniquePhone()}`,
      phone: uniquePhone(),
      roles: ['customer'],
      homeStoreId: b.stores.amp,
    }),
  ).json<{ id: string }>().id;
}

async function bill(partyId: string, quantity: number) {
  const draft = await b.draft({
    storeId: b.stores.amp,
    partyId,
    lines: [{ variantId: b.apex, quantity }],
  });
  return ok(await api(t, b.owner).post(`/invoices/${draft.id}/issue`, {})).json<{
    id: string;
    number: string;
  }>();
}

/** A ₹118.00 invoice link, paid ₹200.00 by the gateway: ₹82.00 is not owed. */
async function overpaid(name: string) {
  const party = await customer(name);
  const invoice = await bill(party, 1);
  const { link } = ok(
    await api(t, b.owner).post('/payment-links', {
      partyId: party,
      purpose: 'invoice',
      invoiceId: invoice.id,
    }),
  ).json<PaymentLinkCreated>();
  const paid = gateway().webhook({
    type: 'payment.captured',
    linkId: referenceOf(link),
    payment: { amountPaise: 20_000 },
  });
  expect(await received(paid)).toBe('applied');
  return { party, link, invoice };
}

const view = async (id: string) =>
  ok(await api(t, b.owner).get(`/payment-links/${id}`)).json<PaymentLinkView>();
const refundsOf = (linkId: string) =>
  t.connection.db
    .select()
    .from(paymentLinkRefunds)
    .where(eq(paymentLinkRefunds.linkId, linkId))
    .orderBy(paymentLinkRefunds.createdAt, paymentLinkRefunds.id);
const balanceOf = async (partyId: string) => {
  const [row] = await t.connection.db
    .select({ balance: partyBalances.balancePaise, advance: partyBalances.advancePaise })
    .from(partyBalances)
    .where(eq(partyBalances.partyId, partyId));
  return row;
};
const noticesOf = (title: string) =>
  t.connection.db
    .selectDistinct({ title: notifications.title, body: notifications.body })
    .from(notifications)
    .where(
      and(
        eq(notifications.organizationId, b.organizationId),
        eq(notifications.event, 'payment_link_refund'),
        sql`${notifications.title} like ${`%${title}%`}`,
      ),
    );
async function booksBalance() {
  await withTenant(t.connection.db, b.organizationId, async (tx) => {
    expect(await findPartyBalanceMismatches(tx)).toEqual([]);
    expect(await findAllocationMismatches(tx)).toEqual([]);
  });
}
/** Makes waiting refunds of a link due now, as if their wait had passed. */
const due = (linkId: string) =>
  t.connection.db
    .update(paymentLinkRefunds)
    .set({ nextAttemptAt: sql`now() - interval '1 second'` })
    .where(and(eq(paymentLinkRefunds.linkId, linkId), eq(paymentLinkRefunds.status, 'pending')));
const run = () => runDueLinkRefunds(t.connection.db, gateways(), notifier());

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString, { PAYMENT_LINK_PROVIDER: 'log' });
  b = await billingBusiness(t);
});

afterEach(() => {
  gateway().refundBehaviour = 'process';
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('a refund through the gateway', () => {
  it('is booked once even when the gateway took it before a crash ([PO-44] retry-safe)', async () => {
    gateway().refundBehaviour = 'unreachable';
    const { party, link } = await overpaid('Crash');
    const [waiting] = await refundsOf(link.id);
    expect(waiting).toMatchObject({ status: 'pending', attempts: 1, amountPaise: 8_200 });
    // The gateway took it under this receipt, but our books were never written.
    gateway().refundBehaviour = 'process';
    const taken = await gateway().refundPayment({
      gatewayPaymentId: String(waiting?.gatewayPaymentId),
      amountPaise: 8_200,
      receipt: String(waiting?.id),
      notes: {},
    });
    await due(link.id);
    expect(await run()).toBe(1);
    const [refund] = await refundsOf(link.id);
    expect(refund).toMatchObject({
      status: 'refunded',
      gatewayRefundId: taken.gatewayRefundId,
      gatewayStatus: 'processed',
    });
    expect(gateway().refunds.size).toBeGreaterThan(0);
    const out = await t.connection.db
      .select()
      .from(payments)
      .where(and(eq(payments.paymentLinkId, link.id), eq(payments.direction, 'out')));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      amountPaise: 8_200,
      modeKind: 'upi_link',
      gatewayReference: taken.gatewayRefundId,
      createdByMemberId: null,
      registerSessionId: null,
    });
    expect(out[0]?.note).toBe(`Refunded through the gateway for UPI link ${link.number}`);
    expect(await balanceOf(party)).toEqual({ balance: 0, advance: 0 });
    // Nothing is due any more: another run refunds nothing.
    expect(await run()).toBe(0);
    await booksBalance();
  });

  it('keeps the money an advance when the gateway cannot be reached, tells staff once, and tries again', async () => {
    gateway().refundBehaviour = 'unreachable';
    const { party, link } = await overpaid('Unreachable');
    expect(await balanceOf(party)).toEqual({ balance: -8_200, advance: 8_200 });
    expect(await view(link.id)).toMatchObject({
      refundedPaise: 0,
      refundPendingPaise: 8_200,
      refundFailed: true,
      refunds: [{ status: 'pending', attempts: 1, lastError: 'unreachable' }],
    });
    // Not due yet: the next try waits a minute.
    expect(await run()).toBe(0);
    await due(link.id);
    expect(await run()).toBe(0);
    const [second] = await refundsOf(link.id);
    expect(second).toMatchObject({ status: 'pending', attempts: 2 });
    expect(await noticesOf('Unreachable')).toEqual([
      {
        title: expect.stringMatching(/^Refund failed, kept as an advance: Unreachable/) as string,
        body: `₹82.00 paid by ${link.number} could not be refunded yet (unreachable). It is kept as an advance and tried again.`,
      },
    ]);

    gateway().refundBehaviour = 'process';
    await due(link.id);
    expect(await run()).toBe(1);
    expect(await balanceOf(party)).toEqual({ balance: 0, advance: 0 });
    expect(await view(link.id)).toMatchObject({ refundedPaise: 8_200, refundFailed: false });
    await booksBalance();
  });

  it('is given up after its last try: the money stays an advance and staff are told', async () => {
    gateway().refundBehaviour = 'reject';
    const { party, link } = await overpaid('Given Up');
    await t.connection.db
      .update(paymentLinkRefunds)
      .set({ attempts: MAX_REFUND_ATTEMPTS - 1 })
      .where(eq(paymentLinkRefunds.linkId, link.id));
    await due(link.id);
    expect(await run()).toBe(0);
    const [refund] = await refundsOf(link.id);
    expect(refund).toMatchObject({
      status: 'failed',
      attempts: MAX_REFUND_ATTEMPTS,
      lastError: 'BAD_REQUEST_ERROR',
    });
    expect(await balanceOf(party)).toEqual({ balance: -8_200, advance: 8_200 });
    expect(await view(link.id)).toMatchObject({ refundPendingPaise: 8_200, refundFailed: true });
    expect(await noticesOf('Given Up')).toEqual(
      expect.arrayContaining([
        {
          title: expect.stringMatching(/^Refund given up, kept as an advance/) as string,
          body: `₹82.00 paid by ${link.number} could not be refunded after ${String(MAX_REFUND_ATTEMPTS)} tries (BAD_REQUEST_ERROR). It stays an advance: refund it by hand or allocate it.`,
        },
      ]),
    );
    await booksBalance();
  });

  it('is dropped when staff allocate the money meanwhile', async () => {
    gateway().refundBehaviour = 'unreachable';
    const { party, link } = await overpaid('Used');
    const later = await bill(party, 1);
    const [payment] = (await view(link.id)).payments;
    ok(
      await api(t, b.owner).post(`/payments/${String(payment?.id)}/allocate`, {
        allocations: [{ documentId: later.id, amountPaise: 8_200 }],
      }),
    );
    gateway().refundBehaviour = 'process';
    await due(link.id);
    expect(await run()).toBe(0);
    expect(await refundsOf(link.id)).toMatchObject([
      { status: 'dropped', lastError: 'used_meanwhile' },
    ]);
    expect(await balanceOf(party)).toEqual({ balance: 3_600, advance: 0 });
    await booksBalance();
  });

  it('fails a try when the business has no gateway, and skips a refund already done or unknown', async () => {
    gateway().refundBehaviour = 'unreachable';
    const { link } = await overpaid('No Gateway');
    const [refund] = await refundsOf(link.id);
    const outcome = await withTenant(t.connection.db, b.organizationId, (tx) =>
      attemptLinkRefund(tx, String(refund?.id), null, notifier()),
    );
    expect(outcome).toBe('retrying');
    expect((await refundsOf(link.id))[0]).toMatchObject({
      attempts: 2,
      lastError: 'gateway_not_connected',
    });
    gateway().refundBehaviour = 'process';
    await due(link.id);
    await run();
    const again = await withTenant(t.connection.db, b.organizationId, (tx) =>
      attemptLinkRefund(tx, String(refund?.id), gateway(), notifier()),
    );
    expect(again).toBe('skipped');
    const unknown = await withTenant(t.connection.db, b.organizationId, (tx) =>
      attemptLinkRefund(tx, '00000000-0000-4000-8000-000000000000', gateway(), notifier()),
    );
    expect(unknown).toBe('skipped');
  });
});

describe('the gateway’s refund news', () => {
  it('notes a processed refund once, and ignores news of refunds it does not have', async () => {
    const { link } = await overpaid('Processed');
    const [refund] = await refundsOf(link.id);
    // The log gateway answered "processed"; Razorpay may answer "pending" first.
    await t.connection.db
      .update(paymentLinkRefunds)
      .set({ gatewayStatus: 'pending' })
      .where(eq(paymentLinkRefunds.id, String(refund?.id)));
    const news = gateway().webhook({
      type: 'refund.processed',
      refund: {
        id: String(refund?.gatewayRefundId),
        paymentId: String(refund?.gatewayPaymentId),
        amountPaise: 8_200,
      },
    });
    expect(await received(news)).toBe('applied');
    expect(await received(news)).toBe('duplicate');
    expect((await refundsOf(link.id))[0]?.gatewayStatus).toBe('processed');
    const again = gateway().webhook({
      type: 'refund.processed',
      refund: {
        id: String(refund?.gatewayRefundId),
        paymentId: String(refund?.gatewayPaymentId),
        amountPaise: 8_200,
      },
    });
    expect(await received(again)).toBe('ignored');
    const unknown = gateway().webhook({
      type: 'refund.failed',
      refund: { id: 'rfnd_log_unknown', paymentId: 'pay_x', amountPaise: 1 },
    });
    expect(await received(unknown)).toBe('ignored');
  });

  it('ignores news of a refund still waiting for its try', async () => {
    gateway().refundBehaviour = 'unreachable';
    const { link } = await overpaid('Waiting News');
    const [refund] = await refundsOf(link.id);
    await t.connection.db
      .update(paymentLinkRefunds)
      .set({ gatewayRefundId: 'rfnd_log_waiting' })
      .where(eq(paymentLinkRefunds.id, String(refund?.id)));
    const news = gateway().webhook({
      type: 'refund.failed',
      refund: { id: 'rfnd_log_waiting', paymentId: 'pay_x', amountPaise: 8_200 },
    });
    expect(await received(news)).toBe('ignored');
  });

  it('brings a refund the gateway failed back as an advance, and refunds it again', async () => {
    const { party, link } = await overpaid('Returned');
    const [refund] = await refundsOf(link.id);
    expect(await balanceOf(party)).toEqual({ balance: 0, advance: 0 });
    const failed = gateway().webhook({
      type: 'refund.failed',
      refund: {
        id: String(refund?.gatewayRefundId),
        paymentId: String(refund?.gatewayPaymentId),
        amountPaise: 8_200,
      },
    });
    gateway().refundBehaviour = 'unreachable';
    expect(await received(failed)).toBe('applied');
    expect(await balanceOf(party)).toEqual({ balance: -8_200, advance: 8_200 });
    const [returned, retry] = await refundsOf(link.id);
    expect(returned).toMatchObject({ status: 'returned', gatewayStatus: 'failed' });
    expect(retry).toMatchObject({
      status: 'pending',
      retryOfId: returned?.id,
      paymentId: returned?.returnedPaymentId,
      gatewayPaymentId: refund?.gatewayPaymentId,
      amountPaise: 8_200,
      reason: 'overpaid',
    });
    const [back] = await t.connection.db
      .select()
      .from(payments)
      .where(eq(payments.id, String(returned?.returnedPaymentId)));
    expect(back).toMatchObject({
      direction: 'in',
      gatewayReference: `${String(refund?.gatewayRefundId)}/returned`,
      paymentLinkId: link.id,
    });
    expect(await noticesOf('Returned')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: expect.stringMatching(/^Refund failed at the gateway, kept as an advance/) as string,
          body: expect.stringContaining('It is tried again.') as string,
        }),
      ]),
    );

    gateway().refundBehaviour = 'process';
    await due(link.id);
    expect(await run()).toBe(1);
    expect(await balanceOf(party)).toEqual({ balance: 0, advance: 0 });
    expect(await view(link.id)).toMatchObject({ refundedPaise: 8_200, refundPendingPaise: 0 });
    await booksBalance();
  });

  it('gives up a returned refund whose tries are used up', async () => {
    const { party, link } = await overpaid('Returned Late');
    const [refund] = await refundsOf(link.id);
    await t.connection.db
      .update(paymentLinkRefunds)
      .set({ attempts: MAX_REFUND_ATTEMPTS - 1 })
      .where(eq(paymentLinkRefunds.id, String(refund?.id)));
    const failed = gateway().webhook({
      type: 'refund.failed',
      refund: {
        id: String(refund?.gatewayRefundId),
        paymentId: String(refund?.gatewayPaymentId),
        amountPaise: 8_200,
      },
    });
    expect(await received(failed)).toBe('applied');
    expect((await refundsOf(link.id))[1]).toMatchObject({ status: 'failed' });
    expect(await balanceOf(party)).toEqual({ balance: -8_200, advance: 8_200 });
    expect(await noticesOf('Returned Late')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.stringContaining('Refund it by hand or allocate it.') as string,
        }),
      ]),
    );
  });
});

describe('gateway refunds in the books', () => {
  it('go to Tally as refunds of the link receipt, and show on the customer ledger', async () => {
    const { party, link } = await overpaid('Tally Refund');
    const [, refund] = await t.connection.db
      .select()
      .from(payments)
      .where(eq(payments.paymentLinkId, link.id))
      .orderBy(payments.createdAt, payments.id);
    expect(refund).toMatchObject({ direction: 'out' });
    const today = await dbToday(t);
    const xml = ok(
      await api(t, b.owner).post('/accounting-exports', {
        from: today,
        to: today,
        kinds: ['receipt'],
        format: 'tally_xml',
      }),
    ).body;
    // A refund of an advance that had a receipt voucher goes by its refund voucher (Rule 51).
    expect(refund?.voucherNumber).toEqual(expect.any(String));
    expect(xml).toContain(String(refund?.voucherNumber));
    expect(xml).toContain('Payment Gateway Clearing');
    const ledger = ok(await api(t, b.owner).get(`/parties/${party}/ledger`)).json<{
      entries: { entryType: string; amountPaise: number; referenceNumber: string | null }[];
    }>();
    expect(ledger.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryType: 'refund_out',
          amountPaise: 8_200,
          referenceNumber: refund?.number,
        }),
      ]),
    );
  });
});
