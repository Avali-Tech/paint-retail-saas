import { findReservationMismatches, findStockMismatches, migrateDatabase, schema } from '@paint/db';
import type {
  DispatchView,
  InsufficientStockRefusal,
  InvoiceDispatchesView,
  IssuedInvoiceView,
  SalesOrderView,
  SalesReturnView,
  TaxDocumentView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  issuesOf,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';

const { creditProfiles, parties, stockBalances } = schema;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  await t.connection.db.insert(creditProfiles).values({
    organizationId: b.organizationId,
    partyId: b.parties.contractor,
    status: 'active',
    limitPaise: 1_000_000_000,
    creditDays: 15,
  });
  // Big bills to an unregistered buyer carry its address (Rule 46(e)).
  await t.connection.db
    .update(parties)
    .set({ addressLine: '7 Site Road', city: 'Hyderabad', placeOfSupply: '36' })
    .where(eq(parties.id, b.parties.contractor));
  // Bill now, hand over later (spec §4.2).
  ok(await api(t, b.owner).put('/sales/settings', { stockPostOn: 'dispatch' }));
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

const owner = () => api(t, b.owner);

async function stock(storeId = b.stores.amp) {
  const [row] = await t.connection.db
    .select({ onHand: stockBalances.onHand, reserved: stockBalances.reserved })
    .from(stockBalances)
    .where(and(eq(stockBalances.storeId, storeId), eq(stockBalances.variantId, b.apex)));
  return { onHand: Number(row?.onHand), reserved: Number(row?.reserved) };
}

/** A confirmed postpaid order of `quantity` litres for the contractor at Ameerpet. */
async function placed(quantity: number, unitPricePaise?: number): Promise<SalesOrderView> {
  const order = ok(
    await owner().post('/sales-orders', {
      storeId: b.stores.amp,
      billToPartyId: b.parties.contractor,
      paymentTerms: 'postpaid',
      lines: [{ variantId: b.apex, quantity, unitPricePaise }],
    }),
  ).json<SalesOrderView>();
  return ok(await owner().post(`/sales-orders/${order.id}/confirm`, {})).json<SalesOrderView>();
}

/** Bills `quantity` of the order's line and issues it. */
async function billed(order: SalesOrderView, quantity: number): Promise<IssuedInvoiceView> {
  const draft = ok(
    await owner().post(`/sales-orders/${order.id}/invoices`, {
      lines: [{ orderLineId: order.lines[0]?.id, quantity }],
    }),
  ).json<TaxDocumentView>();
  return ok(await owner().post(`/invoices/${draft.id}/issue`, {})).json<IssuedInvoiceView>();
}

const dispatch = (invoiceId: string, body: object = {}, headers: Record<string, string> = {}) =>
  api(t, b.owner, headers).post(`/invoices/${invoiceId}/dispatches`, body);
const dispatchesOf = async (invoiceId: string) =>
  ok(await owner().get(`/invoices/${invoiceId}/dispatches`)).json<InvoiceDispatchesView>();

describe('stock out on dispatch (spec §4.2)', () => {
  it('bills now and takes the stock out as the goods leave, in parts', async () => {
    const before = await stock();
    const order = await placed(5);
    const invoice = await billed(order, 3);
    expect(await stock()).toEqual({ onHand: before.onHand, reserved: before.reserved + 5 });
    const [line] = invoice.lines as [IssuedInvoiceView['lines'][0]];

    let status = await dispatchesOf(invoice.id);
    expect(status).toMatchObject({
      invoiceId: invoice.id,
      stockPosting: 'on_dispatch',
      ewayThresholdPaise: 5_000_000,
      dispatches: [],
    });
    expect(status.lines).toEqual([
      {
        invoiceLineId: line.id,
        lineNo: 1,
        variantId: b.apex,
        description: 'Apex Ultima 1 l',
        quantity: 3,
        dispatchedQuantity: 0,
        pendingQuantity: 3,
      },
    ]);

    const headers = { 'idempotency-key': `dispatch-${invoice.id}` };
    const body = { lines: [{ invoiceLineId: line.id, quantity: 2 }], vehicleNo: 'ts09 ab 1234' };
    const first = ok(await dispatch(invoice.id, body, headers)).json<DispatchView>();
    expect(first).toMatchObject({
      number: expect.stringMatching(/^DS-\d{6}$/),
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      storeId: b.stores.amp,
      vehicleNo: 'TS09 AB 1234',
      ewayBillNo: null,
      valuePaise: 23_600,
      stockPosted: true,
      lines: [{ invoiceLineId: line.id, variantId: b.apex, quantity: 2, valuePaise: 23_600 }],
    });
    expect(ok(await dispatch(invoice.id, body, headers)).json<DispatchView>().id).toBe(first.id);
    expect(await stock()).toEqual({ onHand: before.onHand - 2, reserved: before.reserved + 3 });

    const over = await dispatch(invoice.id, { lines: [{ invoiceLineId: line.id, quantity: 2 }] });
    expect(issuesOf(over)).toEqual(['lines.0.quantity']);
    expect(
      issuesOf(
        await dispatch(invoice.id, {
          lines: [{ invoiceLineId: crypto.randomUUID(), quantity: 1 }],
        }),
      ),
    ).toEqual(['lines.0.invoiceLineId']);

    const rest = ok(await dispatch(invoice.id, { note: 'Last of it' })).json<DispatchView>();
    expect(rest).toMatchObject({ note: 'Last of it', lines: [{ quantity: 1 }] });
    expect((await dispatch(invoice.id)).statusCode).toBe(409);
    status = await dispatchesOf(invoice.id);
    expect(status.lines[0]).toMatchObject({ dispatchedQuantity: 3, pendingQuantity: 0 });
    expect(status.dispatches.map((row) => row.id)).toEqual([first.id, rest.id]);
    expect(await stock()).toEqual({ onHand: before.onHand - 3, reserved: before.reserved + 2 });

    const order2 = ok(await owner().get(`/sales-orders/${order.id}`)).json<SalesOrderView>();
    expect(order2.reservations.filter((row) => row.consumedByType === 'dispatch')).toHaveLength(2);
    expect(await findReservationMismatches(t.connection.db)).toEqual([]);
    expect(await findStockMismatches(t.connection.db)).toEqual([]);

    // Goods that have left are not cancelled: a credit note is raised instead.
    expect(
      (await owner().post(`/invoices/${invoice.id}/cancel`, { reason: 'Mistake' })).statusCode,
    ).toBe(409);
  });

  it('takes back only what has left, and cancels an undispatched bill without moving stock', async () => {
    const order = await placed(4);
    const invoice = await billed(order, 4);
    const [line] = invoice.lines as [IssuedInvoiceView['lines'][0]];
    ok(await dispatch(invoice.id, { lines: [{ invoiceLineId: line.id, quantity: 1 }] }));
    const tooMany = await owner().post('/sales-returns', {
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: line.id, quantity: 2, disposition: 'restock' }],
    });
    expect(tooMany.statusCode).toBe(422);
    expect(JSON.stringify(tooMany.json())).toContain('At most 1 of line 1');
    ok(
      await owner().post('/sales-returns', {
        invoiceId: invoice.id,
        lines: [{ invoiceLineId: line.id, quantity: 1, disposition: 'restock' }],
      }),
    ).json<SalesReturnView>();

    const waiting = await placed(2);
    const notGone = await billed(waiting, 2);
    const before = await stock();
    ok(
      await owner().post(`/invoices/${notGone.id}/cancel`, {
        reason: 'Customer will collect later',
      }),
    );
    expect(await stock()).toEqual(before);
    const reopened = ok(await owner().get(`/sales-orders/${waiting.id}`)).json<SalesOrderView>();
    expect(reopened).toMatchObject({ status: 'confirmed' });
    expect(reopened.lines[0]).toMatchObject({ quantityOpen: 2, quantityReserved: 2 });
  });

  it('holds again what a stale release gave back before billing for dispatch, or refuses', async () => {
    const order = await placed(2);
    ok(await owner().post(`/sales-orders/${order.id}/release`, {}));
    const invoice = await billed(order, 2);
    expect(
      ok(await owner().get(`/sales-orders/${order.id}`)).json<SalesOrderView>().lines[0]
        ?.quantityReserved,
    ).toBe(2);
    expect((await dispatchesOf(invoice.id)).stockPosting).toBe('on_dispatch');

    const huge = await placed(1);
    ok(await owner().post(`/sales-orders/${huge.id}/release`, {}));
    const available = await stock();
    await t.connection.db
      .update(stockBalances)
      .set({ reserved: available.onHand })
      .where(and(eq(stockBalances.storeId, b.stores.amp), eq(stockBalances.variantId, b.apex)));
    const draft = ok(
      await owner().post(`/sales-orders/${huge.id}/invoices`, {}),
    ).json<TaxDocumentView>();
    const refused = await owner().post(`/invoices/${draft.id}/issue`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json<InsufficientStockRefusal>().code).toBe('insufficient_stock');
    await t.connection.db
      .update(stockBalances)
      .set({ reserved: available.reserved })
      .where(and(eq(stockBalances.storeId, b.stores.amp), eq(stockBalances.variantId, b.apex)));
  });
});

describe('dispatch records and the e-way bill (spec §2.10)', () => {
  it('records the dispatch of a counter invoice without moving stock again', async () => {
    const draft = await b.draft({
      partyId: b.parties.homeowner,
      lines: [{ variantId: b.apex, quantity: 2 }],
    });
    const invoice = ok(
      await owner().post(`/invoices/${draft.id}/issue`, {}),
    ).json<IssuedInvoiceView>();
    const before = await stock();
    const record = ok(await dispatch(invoice.id)).json<DispatchView>();
    expect(record).toMatchObject({ stockPosted: false, valuePaise: 23_600 });
    expect(await stock()).toEqual(before);
    expect((await dispatchesOf(invoice.id)).stockPosting).toBe('on_issue');
  });

  it('needs the e-way bill number above the GSTIN’s threshold', async () => {
    const order = await placed(1, 6_000_000);
    const invoice = await billed(order, 1);
    const refused = await dispatch(invoice.id);
    expect(issuesOf(refused)).toEqual(['ewayBillNo']);
    expect(JSON.stringify(refused.json())).toContain('need an e-way bill');
    expect(issuesOf(await dispatch(invoice.id, { ewayBillNo: 'EWB-1' }))).toEqual(['ewayBillNo']);
    const sent = ok(
      await dispatch(invoice.id, { ewayBillNo: '123456789012', ewayValidUntil: '2026-12-31' }),
    ).json<DispatchView>();
    expect(sent).toMatchObject({ ewayBillNo: '123456789012', ewayValidUntil: '2026-12-31' });

    // A lower threshold set for the GSTIN applies.
    ok(
      await owner().put(`/gstin-profiles/${String(invoice.supplier.gstin)}`, {
        aatoBand: 'up_to_5cr',
        einvoiceRequiredFrom: null,
        ewayThresholdPaise: 10_000,
      }),
    );
    const small = await billed(await placed(1), 1);
    expect(issuesOf(await dispatch(small.id))).toEqual(['ewayBillNo']);
    expect((await dispatchesOf(small.id)).ewayThresholdPaise).toBe(10_000);
  });

  it('dispatches only issued invoices, by staff who bill', async () => {
    const draft = await b.draft({ lines: [{ variantId: b.apex, quantity: 1 }] });
    expect((await dispatch(draft.id)).statusCode).toBe(409);
    const invoice = ok(
      await owner().post(`/invoices/${draft.id}/issue`, {
        payments: [{ modeId: b.modes.upi.id, amountPaise: 11_800, reference: 'UTR9' }],
      }),
    ).json<IssuedInvoiceView>();
    const note = ok(
      await owner().post('/credit-notes', {
        invoiceId: invoice.id,
        reason: 'overcharge',
        lines: [{ invoiceLineId: invoice.lines[0]?.id, valuePaise: 100 }],
      }),
    ).json<{ id: string }>();
    expect((await dispatch(note.id)).statusCode).toBe(409);
    const manager = await b.member('inventory_manager', [b.stores.amp]);
    expect((await api(t, manager).post(`/invoices/${invoice.id}/dispatches`, {})).statusCode).toBe(
      403,
    );
    expect((await api(t, manager).get(`/invoices/${invoice.id}/dispatches`)).statusCode).toBe(403);
    const employee = await b.member('store_employee', [b.stores.amp]);
    ok(
      await api(t, employee).post(`/invoices/${invoice.id}/dispatches`, {
        ewayBillNo: '210987654321',
      }),
    );
  });
});

const EWAY = { ewayBillNo: '123456789012', ewayValidUntil: '2026-12-31' };

describe('no dispatch on an unpaid bill while the customer or its site is held', () => {
  /** A site of the contractor's with a site account, and an order placed and billed on it. */
  async function billedOnSite(name: string) {
    const project = ok(
      await owner().post('/projects', {
        storeId: b.stores.amp,
        customerPartyId: b.parties.contractor,
        name,
      }),
    ).json<{ id: string }>();
    const site = ok(
      await owner().post(`/parties/${b.parties.contractor}/sites`, {
        projectId: project.id,
        limitPaise: 100_000_000,
      }),
    ).json<{ id: string }>();
    const order = ok(
      await owner().post('/sales-orders', {
        storeId: b.stores.amp,
        billToPartyId: b.parties.contractor,
        projectId: project.id,
        paymentTerms: 'postpaid',
        lines: [{ variantId: b.apex, quantity: 2 }],
      }),
    ).json<SalesOrderView>();
    const confirmed = ok(
      await owner().post(`/sales-orders/${order.id}/confirm`, {}),
    ).json<SalesOrderView>();
    return { siteId: site.id, invoice: await billed(confirmed, 2) };
  }

  it('holds back the goods while the customer is on hold, until the bill is paid', async () => {
    const invoice = await billed(await placed(2), 2);
    ok(
      await owner().post(`/parties/${b.parties.contractor}/credit/hold`, {
        reason: 'Cheque bounced',
      }),
    );
    try {
      const refused = await dispatch(invoice.id);
      expect(refused.statusCode).toBe(409);
      expect(refused.json<{ message: string }>().message).toMatch(
        new RegExp(
          `still owed on ${String(invoice.number)} and the customer's credit is on hold \\(Cheque bounced\\)`,
        ),
      );
      expect((await dispatchesOf(invoice.id)).dispatches).toEqual([]);

      ok(
        await owner().post('/payments', {
          storeId: b.stores.amp,
          partyId: b.parties.contractor,
          modeId: b.modes.upi.id,
          amountPaise: invoice.totalPaise,
          reference: 'UTR-PAID-IN-FULL',
          allocations: [{ documentId: invoice.id, amountPaise: invoice.totalPaise }],
        }),
      );
      expect(ok(await dispatch(invoice.id, EWAY)).json<DispatchView>().valuePaise).toBe(
        invoice.totalPaise,
      );
    } finally {
      ok(await owner().post(`/parties/${b.parties.contractor}/credit/release`, {}));
    }
  });

  it('holds back the goods for a held site, and only that site', async () => {
    const held = await billedOnSite('Tower A, Gachibowli');
    const other = await billedOnSite('Villa 12, Shamshabad');
    ok(
      await owner().post(`/site-accounts/${held.siteId}/hold`, { reason: 'Builder has not paid' }),
    );

    const refused = await dispatch(held.invoice.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ message: string }>().message).toMatch(
      /the site Tower A, Gachibowli is on hold \(Builder has not paid\)\. Take the payment or release the site/,
    );
    // The contractor's other site still takes delivery.
    ok(await dispatch(other.invoice.id, EWAY));

    ok(await owner().post(`/site-accounts/${held.siteId}/release`, {}));
    ok(await dispatch(held.invoice.id, EWAY));
  });

  it('lets a walk-in bill go: billed to the walk-in party, which is never held', async () => {
    const draft = await b.draft({ lines: [{ variantId: b.apex, quantity: 1 }] });
    expect(draft.buyer.partyId).toBeNull();
    const invoice = ok(
      await owner().post(`/invoices/${draft.id}/issue`, {
        payments: [{ modeId: b.modes.upi.id, amountPaise: 11_800, reference: 'UTR-WALK-IN' }],
      }),
    ).json<IssuedInvoiceView>();
    ok(await dispatch(invoice.id, EWAY));
  });

  it('holds back the goods for a closed site', async () => {
    const { siteId, invoice } = await billedOnSite('Plot 4, Kokapet');
    ok(await owner().post(`/site-accounts/${siteId}/close`, {}));
    const refused = await dispatch(invoice.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ message: string }>().message).toMatch(
      /still owed on .+ and the site Plot 4, Kokapet is closed\. Take the payment before dispatching\./,
    );
  });
});
