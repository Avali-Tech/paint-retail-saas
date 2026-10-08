import {
  findAllocationMismatches,
  findPartyBalanceMismatches,
  findReservationMismatches,
  findStockMismatches,
  migrateDatabase,
  postStockMovements,
  schema,
  withTenant,
} from '@paint/db';
import type {
  CreditApprovalRefusal,
  AdvanceRequiredRefusal,
  InsufficientStockRefusal,
  IssuedInvoiceView,
  OrderAvailabilityView,
  OrderCreditView,
  QuotationView,
  SalesOrderPage,
  SalesOrderView,
  StaleReservationPage,
  TaxDocumentView,
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
  type Reply,
} from '../test-support/billing-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';

const { auditLog, creditProfiles, stockBalances } = schema;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;

/** §6.3's example: a ₹30,000 limit with ₹18,000 owed, 30 days to pay. */
const LIMIT = 3_000_000;
const OWED = 1_800_000;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  await t.connection.db.insert(creditProfiles).values({
    organizationId: b.organizationId,
    partyId: b.parties.contractor,
    status: 'active',
    limitPaise: LIMIT,
    creditDays: 30,
    manualExposurePaise: OWED,
  });
  // The godown counter has none left.
  await withTenant(t.connection.db, b.organizationId, (tx) =>
    postStockMovements(tx, [
      {
        organizationId: b.organizationId,
        storeId: b.stores.unr,
        variantId: b.apex,
        movementType: 'adjustment',
        quantity: -10_000,
      },
    ]),
  );
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

const owner = () => api(t, b.owner);
const orderBody = (body: object = {}) => ({
  storeId: b.stores.amp,
  billToPartyId: b.parties.contractor,
  paymentTerms: 'postpaid',
  lines: [{ variantId: b.apex, quantity: 2 }],
  ...body,
});
const order = async (body: object = {}, token = b.owner) =>
  ok(await api(t, token).post('/sales-orders', orderBody(body))).json<SalesOrderView>();
/** One line worth exactly `paise` (tax inclusive). */
const worth = (paise: number) => ({
  lines: [{ variantId: b.apex, quantity: 1, unitPricePaise: paise }],
});
const confirm = (id: string, body: object = {}, token = b.owner) =>
  api(t, token).post(`/sales-orders/${id}/confirm`, body);
const confirmed = async (body: object = {}) => {
  const created = await order(body);
  return ok(await confirm(created.id)).json<SalesOrderView>();
};
const bill = (id: string, body: object = {}, token = b.owner) =>
  api(t, token).post(`/sales-orders/${id}/invoices`, body);
const issue = (id: string, body: object = {}) => owner().post(`/invoices/${id}/issue`, body);
const view = async (id: string) =>
  ok(await owner().get(`/sales-orders/${id}`)).json<SalesOrderView>();

async function stock(storeId: string) {
  const [row] = await t.connection.db
    .select({ onHand: stockBalances.onHand, reserved: stockBalances.reserved })
    .from(stockBalances)
    .where(and(eq(stockBalances.storeId, storeId), eq(stockBalances.variantId, b.apex)));
  return { onHand: Number(row?.onHand), reserved: Number(row?.reserved) };
}

/** The reply, after checking it is a 409 refusal. */
function refused(reply: Reply): Reply {
  expect(reply.statusCode).toBe(409);
  return reply;
}

describe('draft sales orders', () => {
  it('takes an order direct, priced, with a fulfil store per line', async () => {
    const headers = { 'idempotency-key': 'order-1' };
    const body = orderBody({
      lines: [
        { variantId: b.apex, quantity: 2 },
        { variantId: b.apex, quantity: 1.5, fulfilStoreId: b.stores.kkp },
      ],
    });
    const created = ok(
      await api(t, b.owner, headers).post('/sales-orders', body),
    ).json<SalesOrderView>();

    expect(created).toMatchObject({
      number: expect.stringMatching(/^SO-\d{6}$/),
      status: 'draft',
      paymentTerms: 'postpaid',
      advanceRequiredPaise: null,
      billTo: { id: b.parties.contractor, name: 'Deccan Contractors' },
      quotationId: null,
      quotationNumber: null,
      creditCheck: null,
      creditOverride: null,
      confirmedAt: null,
      invoicedPaise: 0,
      totalPaise: 41_300,
      reservations: [],
      invoices: [],
    });
    expect(created.lines.map((line) => [line.fulfilStoreId, line.quantityOpen])).toEqual([
      [b.stores.amp, 2],
      [b.stores.kkp, 1.5],
    ]);
    expect(
      ok(await api(t, b.owner, headers).post('/sales-orders', body)).json<SalesOrderView>().id,
    ).toBe(created.id);

    const changed = ok(
      await owner().put(`/sales-orders/${created.id}`, orderBody({ paymentTerms: 'prepaid' })),
    ).json<SalesOrderView>();
    expect(changed).toMatchObject({ paymentTerms: 'prepaid', totalPaise: 23_600 });
    expect(changed.lines).toHaveLength(1);
    expect((await owner().delete(`/sales-orders/${created.id}`)).statusCode).toBe(204);
    expect((await owner().get(`/sales-orders/${created.id}`)).statusCode).toBe(404);
  });

  it('refuses an unknown fulfil store, a member of another store, and staff who only bill', async () => {
    const unknown = await owner().post(
      '/sales-orders',
      orderBody({
        lines: [{ variantId: b.apex, quantity: 1, fulfilStoreId: crypto.randomUUID() }],
      }),
    );
    expect(unknown.statusCode).toBe(400);
    expect(issuesOf(unknown)).toEqual(['lines.0.fulfilStoreId']);

    const created = await order();
    const kukatpally = await b.member('sales_executive', [b.stores.kkp]);
    expect(
      (await api(t, kukatpally).put(`/sales-orders/${created.id}`, orderBody())).statusCode,
    ).toBe(404);
    const employee = await b.member('store_employee', [b.stores.amp]);
    expect((await api(t, employee).post('/sales-orders', orderBody())).statusCode).toBe(403);
    expect((await api(t, employee).get(`/sales-orders/${created.id}`)).statusCode).toBe(200);
  });

  it('keeps an order from a quotation (cancel it instead) and a confirmed one', async () => {
    const quote = ok(
      await owner().post('/quotations', {
        storeId: b.stores.amp,
        billToPartyId: b.parties.contractor,
        lines: [{ variantId: b.apex, quantity: 1 }],
      }),
    ).json<QuotationView>();
    ok(await owner().post(`/quotations/${quote.id}/send`));
    const fromQuote = ok(
      await owner().post(`/quotations/${quote.id}/convert`, { paymentTerms: 'postpaid' }),
    ).json<SalesOrderView>();
    expect((await owner().delete(`/sales-orders/${fromQuote.id}`)).statusCode).toBe(409);

    const done = await confirmed();
    expect((await owner().put(`/sales-orders/${done.id}`, orderBody())).statusCode).toBe(409);
    expect((await owner().delete(`/sales-orders/${done.id}`)).statusCode).toBe(409);
    expect((await confirm(done.id)).statusCode).toBe(409);
  });
});

describe('confirm: credit check (spec §4.4, §6.3)', () => {
  it('asks the owner to approve ₹15,000 on a ₹30,000 limit with ₹18,000 owed (110%)', async () => {
    const created = await order(worth(1_500_000));
    const held = await stock(b.stores.amp);
    const preview = ok(
      await owner().get(`/sales-orders/${created.id}/credit-check`),
    ).json<OrderCreditView>();
    expect(preview).toEqual({
      required: true,
      exposureSource: 'manual',
      position: { status: 'active', limitPaise: LIMIT, exposurePaise: OWED, overdueDays: 0 },
      check: {
        decision: 'owner_approval',
        blockedBecause: null,
        projectedExposurePaise: 3_300_000,
        availablePaise: -300_000,
        utilizationPercent: 110,
      },
      approval: 'owner',
    });

    const asked = refused(await confirm(created.id)).json<CreditApprovalRefusal>();
    expect(asked).toMatchObject({ code: 'credit_approval_required', credit: preview });
    expect(asked.message).toContain('110%');
    expect(asked.message).toContain('the owner');

    // An organisation admin holds credit:approve but is not the owner.
    const admin = await b.member('org_admin', [b.stores.amp]);
    const notOwner = refused(
      await confirm(created.id, { creditOverride: { reason: 'Known customer' } }, admin),
    ).json<CreditApprovalRefusal>();
    expect(notOwner.code).toBe('credit_override_not_allowed');
    expect(await stock(b.stores.amp)).toEqual(held);

    const approved = ok(
      await confirm(created.id, { creditOverride: { reason: 'Pays every month' } }),
    ).json<SalesOrderView>();
    expect(approved).toMatchObject({
      status: 'confirmed',
      creditCheck: preview.check,
      creditOverride: {
        approval: 'owner',
        memberName: 'Owner',
        reason: 'Pays every month',
        at: expect.any(String),
      },
      confirmedAt: expect.any(String),
    });
    expect(approved.reservations).toEqual([
      expect.objectContaining({ storeId: b.stores.amp, quantity: 1, status: 'open' }),
    ]);
    const [audit] = await t.connection.db
      .select({ newValues: auditLog.newValues })
      .from(auditLog)
      .where(and(eq(auditLog.tableName, 'sales_orders'), eq(auditLog.recordId, created.id)))
      .orderBy(sql`${auditLog.id} desc`)
      .limit(1);
    expect(audit?.newValues).toMatchObject({
      status: 'confirmed',
      credit_override_approval: 'owner',
      credit_override_reason: 'Pays every month',
    });
  });

  it('lets a manager approve up to the limit, confirms within the normal share, refuses no credit', async () => {
    const admin = await b.member('org_admin', [b.stores.amp]);
    const managerShare = await order(worth(900_000));
    expect(refused(await confirm(managerShare.id)).json<CreditApprovalRefusal>().message).toContain(
      'a manager',
    );
    const approved = ok(
      await confirm(managerShare.id, { creditOverride: { reason: 'Big site' } }, admin),
    ).json<SalesOrderView>();
    expect(approved.creditOverride).toMatchObject({ approval: 'manager', reason: 'Big site' });

    const normal = ok(await confirm((await order(worth(600_000))).id)).json<SalesOrderView>();
    expect(normal).toMatchObject({
      creditCheck: { decision: 'allowed', utilizationPercent: 80 },
      creditOverride: null,
    });

    const walkIn = await order({ billToPartyId: b.parties.homeowner });
    const blocked = refused(
      await confirm(walkIn.id, { creditOverride: { reason: 'Please' } }),
    ).json<CreditApprovalRefusal>();
    expect(blocked).toMatchObject({
      code: 'credit_blocked',
      credit: { approval: 'blocked', check: { blockedBecause: 'no_credit' } },
    });
    expect(blocked.message).toContain('no credit');
  });

  it('checks nothing for a prepaid order', async () => {
    const created = await order({ paymentTerms: 'prepaid', billToPartyId: b.parties.homeowner });
    expect(
      ok(await owner().get(`/sales-orders/${created.id}/credit-check`)).json<OrderCreditView>(),
    ).toMatchObject({ required: false, check: null, approval: 'none' });
    expect(ok(await confirm(created.id)).json<SalesOrderView>()).toMatchObject({
      status: 'confirmed',
      creditCheck: null,
    });
  });
});

describe('confirm: advance and stock', () => {
  it('needs a partial order’s advance on account first', async () => {
    ok(await owner().put('/sales/settings', { partialMinAdvancePct: 25 }));
    const fresh = await billingBusiness(t);
    ok(await api(t, fresh.owner).put('/sales/settings', { partialMinAdvancePct: 25 }));
    const created = ok(
      await api(t, fresh.owner).post('/sales-orders', {
        storeId: fresh.stores.amp,
        billToPartyId: fresh.parties.homeowner,
        paymentTerms: 'partial',
        lines: [{ variantId: fresh.apex, quantity: 4 }],
      }),
    ).json<SalesOrderView>();
    const short = refused(
      await api(t, fresh.owner).post(`/sales-orders/${created.id}/confirm`, {}),
    ).json<AdvanceRequiredRefusal>();
    expect(short).toMatchObject({
      code: 'advance_required',
      advanceRequiredPaise: 11_800,
      advancePaise: 0,
    });
    ok(
      await api(t, fresh.owner).post('/payments', {
        storeId: fresh.stores.amp,
        partyId: fresh.parties.homeowner,
        modeId: fresh.modes.upi.id,
        amountPaise: 30_000,
        reference: 'UTR0001',
        allocations: [],
      }),
    );
    expect(
      ok(
        await api(t, fresh.owner).post(`/sales-orders/${created.id}/confirm`, {}),
      ).json<SalesOrderView>(),
    ).toMatchObject({ status: 'confirmed', advanceRequiredPaise: 11_800 });
    // The balance is due at once: the party has no credit days.
    const draft = ok(
      await api(t, fresh.owner).post(`/sales-orders/${created.id}/invoices`, {}),
    ).json<TaxDocumentView>();
    expect(
      ok(
        await api(t, fresh.owner).post(`/invoices/${draft.id}/issue`, {}),
      ).json<IssuedInvoiceView>().dueOn,
    ).toBe(await dbToday(t));
    ok(await owner().put('/sales/settings', { partialMinAdvancePct: 0 }));
  });

  it('reserves every line or none, showing each line that is short', async () => {
    const before = await stock(b.stores.kkp);
    const created = await order({
      paymentTerms: 'prepaid',
      lines: [
        { variantId: b.apex, quantity: 1, fulfilStoreId: b.stores.kkp },
        { variantId: b.apex, quantity: before.onHand, fulfilStoreId: b.stores.kkp },
        { variantId: b.apex, quantity: 1, fulfilStoreId: b.stores.amp },
      ],
    });
    const shortage = refused(await confirm(created.id)).json<InsufficientStockRefusal>();
    expect(shortage).toMatchObject({
      code: 'insufficient_stock',
      lines: [
        {
          lineNo: 2,
          storeId: b.stores.kkp,
          wantedQuantity: before.onHand,
          availableQuantity: before.onHand - before.reserved - 1,
        },
      ],
    });
    expect(shortage.message).toContain('line 2');
    expect(await stock(b.stores.kkp)).toEqual(before);
    expect((await view(created.id)).status).toBe('draft');

    // A store with none of it left.
    const nowhere = await order({
      lines: [{ variantId: b.apex, quantity: 1, fulfilStoreId: b.stores.unr }],
    });
    expect(
      refused(await confirm(nowhere.id)).json<InsufficientStockRefusal>().lines[0]
        ?.availableQuantity,
    ).toBe(0);
  });
});

describe('billing an order (spec §5.3)', () => {
  it('bills open quantities store by store, consuming reservations, until fulfilled', async () => {
    const created = await order({
      lines: [
        { variantId: b.apex, quantity: 5 },
        { variantId: b.apex, quantity: 3, fulfilStoreId: b.stores.kkp },
      ],
    });
    const placed = ok(await confirm(created.id)).json<SalesOrderView>();
    const [ampLine, kkpLine] = placed.lines as [
      SalesOrderView['lines'][0],
      SalesOrderView['lines'][0],
    ];
    const ampBefore = await stock(b.stores.amp);

    // Default: everything open at the order's store.
    const draft = ok(await bill(created.id)).json<TaxDocumentView>();
    expect(draft).toMatchObject({
      status: 'draft',
      storeId: b.stores.amp,
      buyer: { partyId: b.parties.contractor },
    });
    expect(draft.lines.map((line) => line.quantity)).toEqual([5]);
    expect(
      (await owner().put(`/invoices/${draft.id}`, { storeId: b.stores.amp, lines: [] })).statusCode,
    ).toBe(400);
    expect(
      (
        await owner().put(`/invoices/${draft.id}`, {
          storeId: b.stores.amp,
          lines: [{ variantId: b.apex, quantity: 1 }],
        })
      ).statusCode,
    ).toBe(409);

    const invoice = ok(await issue(draft.id)).json<IssuedInvoiceView>();
    expect(invoice).toMatchObject({ status: 'issued', totalPaise: 59_000 });
    expect(invoice.dueOn).toBe(await dbToday(t, 30));
    expect(await stock(b.stores.amp)).toEqual({
      onHand: ampBefore.onHand - 5,
      reserved: ampBefore.reserved - 5,
    });
    let current = await view(created.id);
    expect(current).toMatchObject({ status: 'partly_fulfilled', invoicedPaise: 59_000 });
    // Nothing more at Ameerpet; a billed-out line holds nothing.
    expect((await bill(created.id)).statusCode).toBe(409);
    ok(
      await owner().post(`/sales-orders/${created.id}/reserve`, {
        lines: [{ lineId: ampLine.id }],
      }),
    );
    expect(current.lines[0]).toMatchObject({
      quantityInvoiced: 5,
      quantityOpen: 0,
      quantityReserved: 0,
    });
    expect(current.invoices).toEqual([
      expect.objectContaining({ id: draft.id, status: 'issued', number: invoice.number }),
    ]);
    expect(current.reservations).toEqual([
      expect.objectContaining({ orderLineId: kkpLine.id, status: 'open', quantity: 3 }),
      expect.objectContaining({
        orderLineId: ampLine.id,
        status: 'consumed',
        consumedByType: 'tax_document',
        consumedById: draft.id,
      }),
    ]);

    // Part of the Kukatpally line, then the rest.
    const part = ok(
      await bill(created.id, { lines: [{ orderLineId: kkpLine.id, quantity: 1 }] }),
    ).json<TaxDocumentView>();
    expect(part.storeId).toBe(b.stores.kkp);
    ok(await issue(part.id));
    const rest = ok(await bill(created.id, { storeId: b.stores.kkp })).json<TaxDocumentView>();
    expect(rest.lines.map((line) => line.quantity)).toEqual([2]);
    ok(await issue(rest.id));
    current = await view(created.id);
    expect(current).toMatchObject({ status: 'fulfilled', invoicedPaise: 59_000 + 11_800 + 23_600 });
    expect((await bill(created.id)).statusCode).toBe(409);
    expect(await findReservationMismatches(t.connection.db)).toEqual([]);
    expect(await findStockMismatches(t.connection.db)).toEqual([]);
  });

  it('refuses a bill for another store’s line, more than is open, or a store the member is not at', async () => {
    const placed = await confirmed({
      lines: [
        { variantId: b.apex, quantity: 2 },
        { variantId: b.apex, quantity: 1, fulfilStoreId: b.stores.kkp },
      ],
    });
    const [ampLine, kkpLine] = placed.lines as [
      SalesOrderView['lines'][0],
      SalesOrderView['lines'][0],
    ];
    expect(
      issuesOf(
        await bill(placed.id, {
          storeId: b.stores.amp,
          lines: [{ orderLineId: kkpLine.id, quantity: 1 }],
        }),
      ),
    ).toEqual(['lines.0.quantity']);
    expect(
      issuesOf(await bill(placed.id, { lines: [{ orderLineId: ampLine.id, quantity: 3 }] })),
    ).toEqual(['lines.0.quantity']);
    expect(
      issuesOf(
        await bill(placed.id, { lines: [{ orderLineId: crypto.randomUUID(), quantity: 1 }] }),
      ),
    ).toEqual(['lines.0.orderLineId']);
    const kukatpally = await b.member('branch_manager', [b.stores.kkp]);
    expect((await bill(placed.id, { storeId: b.stores.amp }, kukatpally)).statusCode).toBe(403);
    // A member of the fulfil store sees the order and bills its own line.
    ok(await bill(placed.id, { storeId: b.stores.kkp }, kukatpally));
    expect((await bill((await order()).id)).statusCode).toBe(409);
  });

  it('issues each unit once, and only lines still fulfilled from the bill’s store', async () => {
    const placed = await confirmed({
      lines: [
        { variantId: b.apex, quantity: 1 },
        { variantId: b.apex, quantity: 1 },
      ],
    });
    const firstLine = [{ orderLineId: placed.lines[0]?.id, quantity: 1 }];
    const first = ok(await bill(placed.id, { lines: firstLine })).json<TaxDocumentView>();
    const second = ok(await bill(placed.id, { lines: firstLine })).json<TaxDocumentView>();
    ok(await issue(first.id));
    const twice = await issue(second.id);
    expect(twice.statusCode).toBe(409);
    expect(twice.json<{ message: string }>().message).toContain('has only 0 left');

    const moving = await confirmed();
    const stale = ok(await bill(moving.id)).json<TaxDocumentView>();
    ok(
      await owner().post(`/sales-orders/${moving.id}/reserve`, {
        lines: [{ lineId: moving.lines[0]?.id, fulfilStoreId: b.stores.kkp }],
      }),
    );
    expect((await issue(stale.id)).statusCode).toBe(409);
    ok(await owner().post(`/sales-orders/${moving.id}/cancel`, { reason: 'Changed mind' }));
    const cancelled = ok(await bill((await confirmed()).id)).json<TaxDocumentView>();
    await t.connection.db.execute(
      sql`update sales_orders set status = 'cancelled', cancel_reason = 'x', cancelled_at = now(), cancelled_by_member_id = created_by_member_id where id = (select sales_order_id from tax_documents where id = ${cancelled.id})`,
    );
    const late = await issue(cancelled.id);
    expect(late.statusCode).toBe(409);
    expect(late.json<{ message: string }>().message).toContain('cannot be billed');
  });

  it('takes a prepaid order’s bill only paid in full, and shares an amount discount', async () => {
    const placed = await confirmed({
      billToPartyId: b.parties.homeowner,
      paymentTerms: 'prepaid',
      billDiscount: { kind: 'amount', paise: 1_000 },
      lines: [
        { variantId: b.apex, quantity: 2, discount: { kind: 'amount', paise: 200 } },
        { variantId: b.apex, quantity: 2 },
      ],
    });
    const draft = ok(
      await bill(placed.id, {
        lines: [{ orderLineId: placed.lines[0]?.id, quantity: 1 }],
        note: 'First half',
      }),
    ).json<TaxDocumentView>();
    const [firstLine] = placed.lines as [SalesOrderView['lines'][0]];
    expect(draft).toMatchObject({
      billDiscountPaise: Math.round((1_000 * firstLine.taxablePaise) / 2 / placed.taxablePaise),
      note: 'First half',
    });
    expect(draft.lines[0]).toMatchObject({ quantity: 1, discountPaise: 100 });

    const unpaid = await issue(draft.id);
    expect(unpaid.statusCode).toBe(409);
    expect(unpaid.json<{ message: string }>().message).toContain('prepaid');
    ok(
      await owner().post('/payments', {
        storeId: b.stores.amp,
        partyId: b.parties.homeowner,
        modeId: b.modes.upi.id,
        amountPaise: 20_000,
        reference: 'UTR0002',
        allocations: [],
      }),
    );
    const paid = ok(await issue(draft.id, { allocateAdvances: true })).json<IssuedInvoiceView>();
    expect(paid).toMatchObject({ status: 'issued', outstandingPaise: 0 });
  });

  it('gives a same-day cancelled invoice’s units back to the order', async () => {
    const placed = await confirmed({ lines: [{ variantId: b.apex, quantity: 4 }] });
    const draft = ok(
      await bill(placed.id, { lines: [{ orderLineId: placed.lines[0]?.id, quantity: 4 }] }),
    ).json<TaxDocumentView>();
    ok(await issue(draft.id));
    expect((await view(placed.id)).status).toBe('fulfilled');
    ok(await owner().post(`/invoices/${draft.id}/cancel`, { reason: 'Wrong customer' }));
    const reopened = await view(placed.id);
    expect(reopened).toMatchObject({ status: 'confirmed', invoicedPaise: 0 });
    expect(reopened.lines[0]).toMatchObject({
      quantityInvoiced: 0,
      quantityOpen: 4,
      quantityReserved: 0,
    });
    // Held again on request.
    expect(
      ok(await owner().post(`/sales-orders/${placed.id}/reserve`, {})).json<SalesOrderView>()
        .lines[0]?.quantityReserved,
    ).toBe(4);

    // On an order closed meanwhile, the units are cancelled instead.
    const closing = await confirmed({ lines: [{ variantId: b.apex, quantity: 2 }] });
    const half = ok(
      await bill(closing.id, { lines: [{ orderLineId: closing.lines[0]?.id, quantity: 1 }] }),
    ).json<TaxDocumentView>();
    ok(await issue(half.id));
    ok(await owner().post(`/sales-orders/${closing.id}/cancel`, { reason: 'Site stopped' }));
    ok(await owner().post(`/invoices/${half.id}/cancel`, { reason: 'Billed wrong' }));
    expect((await view(closing.id)).lines[0]).toMatchObject({
      quantityInvoiced: 0,
      quantityCancelled: 2,
    });
    expect(await findPartyBalanceMismatches(t.connection.db)).toEqual([]);
    expect(await findAllocationMismatches(t.connection.db)).toEqual([]);
  });
});

describe('cancelling, reserving and releasing', () => {
  it('cancels part of a line, then the rest of the order, releasing what is held', async () => {
    const placed = await confirmed({
      lines: [
        { variantId: b.apex, quantity: 5 },
        { variantId: b.apex, quantity: 1 },
      ],
    });
    const lineId = String(placed.lines[0]?.id);
    const cancel = (body: object, id = lineId) =>
      owner().post(`/sales-orders/${placed.id}/lines/${id}/cancel`, body);
    expect(issuesOf(await cancel({ quantity: 6, reason: 'Too many' }))).toEqual(['quantity']);
    expect(issuesOf(await cancel({ reason: 'Unknown' }, crypto.randomUUID()))).toEqual(['lineId']);
    const less = ok(await cancel({ quantity: 2, reason: 'Two less' })).json<SalesOrderView>();
    expect(less.lines[0]).toMatchObject({
      quantityCancelled: 2,
      quantityOpen: 3,
      quantityReserved: 3,
    });
    expect(less.status).toBe('confirmed');

    const ended = ok(
      await owner().post(`/sales-orders/${placed.id}/cancel`, { reason: 'Customer cancelled' }),
    ).json<SalesOrderView>();
    expect(ended).toMatchObject({ status: 'cancelled', cancelReason: 'Customer cancelled' });
    expect(ended.lines.map((line) => line.quantityReserved)).toEqual([0, 0]);
    expect(ended.lines.map((line) => line.quantityCancelled)).toEqual([5, 1]);
    expect(
      (await owner().post(`/sales-orders/${placed.id}/cancel`, { reason: 'Again' })).statusCode,
    ).toBe(409);
    const draft = await order();
    const notYet = await owner().post(`/sales-orders/${draft.id}/cancel`, { reason: 'Draft' });
    expect(notYet.statusCode).toBe(409);
    expect(notYet.json<{ message: string }>().message).toContain('Confirm this order first');
  });

  it('cancels an order whose last open line is cancelled, and fulfils one that was billed', async () => {
    const single = await confirmed();
    const gone = ok(
      await owner().post(`/sales-orders/${single.id}/lines/${String(single.lines[0]?.id)}/cancel`, {
        reason: 'Not needed',
      }),
    ).json<SalesOrderView>();
    expect(gone).toMatchObject({ status: 'cancelled', cancelReason: 'Not needed' });

    const billed = await confirmed({
      lines: [
        { variantId: b.apex, quantity: 1 },
        { variantId: b.apex, quantity: 1 },
      ],
    });
    ok(
      await issue(
        ok(
          await bill(billed.id, { lines: [{ orderLineId: billed.lines[0]?.id, quantity: 1 }] }),
        ).json<TaxDocumentView>().id,
      ),
    );
    const done = ok(
      await owner().post(`/sales-orders/${billed.id}/lines/${String(billed.lines[1]?.id)}/cancel`, {
        reason: 'Out of shade',
      }),
    ).json<SalesOrderView>();
    expect(done.status).toBe('fulfilled');
    const closing = await confirmed({
      lines: [
        { variantId: b.apex, quantity: 1 },
        { variantId: b.apex, quantity: 1 },
      ],
    });
    ok(
      await issue(
        ok(
          await bill(closing.id, { lines: [{ orderLineId: closing.lines[0]?.id, quantity: 1 }] }),
        ).json<TaxDocumentView>().id,
      ),
    );
    expect(
      ok(
        await owner().post(`/sales-orders/${closing.id}/cancel`, { reason: 'Stop' }),
      ).json<SalesOrderView>().status,
    ).toBe('closed');
  });

  it('releases stale holds, lists them, and holds again, moving a line to another store', async () => {
    const placed = await confirmed({ lines: [{ variantId: b.apex, quantity: 3 }] });
    const lineId = String(placed.lines[0]?.id);
    const stale = async (query: string, token = b.owner) =>
      ok(await api(t, token).get(`/stock-reservations/stale${query}`)).json<StaleReservationPage>();
    expect((await stale('')).items.some((item) => item.orderId === placed.id)).toBe(false);
    const listed = await stale(`?olderThanDays=0&storeId=${b.stores.amp}&limit=200`);
    expect(listed.items.find((item) => item.orderId === placed.id)).toMatchObject({
      orderNumber: placed.number,
      orderLineId: lineId,
      storeId: b.stores.amp,
      sku: 'APX-1L',
      quantity: 3,
      ageDays: 0,
    });
    expect(listed.total).toBeGreaterThanOrEqual(1);
    const kukatpally = await b.member('branch_manager', [b.stores.kkp]);
    expect(
      (await stale('?olderThanDays=0', kukatpally)).items.some(
        (item) => item.orderId === placed.id,
      ),
    ).toBe(false);

    const released = ok(
      await owner().post(`/sales-orders/${placed.id}/release`, { lineIds: [lineId] }),
    ).json<SalesOrderView>();
    expect(released.lines[0]?.quantityReserved).toBe(0);
    expect(
      issuesOf(
        await owner().post(`/sales-orders/${placed.id}/release`, {
          lineIds: [crypto.randomUUID()],
        }),
      ),
    ).toEqual(['lineIds.0']);
    ok(await owner().post(`/sales-orders/${placed.id}/release`, {}));

    const moved = ok(
      await owner().post(`/sales-orders/${placed.id}/reserve`, {
        lines: [{ lineId, fulfilStoreId: b.stores.kkp }],
      }),
    ).json<SalesOrderView>();
    expect(moved.lines[0]).toMatchObject({ fulfilStoreId: b.stores.kkp, quantityReserved: 3 });
    expect(
      issuesOf(
        await owner().post(`/sales-orders/${placed.id}/reserve`, {
          lines: [{ lineId, fulfilStoreId: crypto.randomUUID() }],
        }),
      ),
    ).toEqual(['lines.0.fulfilStoreId']);
    expect(
      issuesOf(
        await owner().post(`/sales-orders/${placed.id}/reserve`, {
          lines: [{ lineId: crypto.randomUUID() }],
        }),
      ),
    ).toEqual(['lines.0.lineId']);
    const empty = ok(await owner().post('/stores', { name: 'New godown', code: 'NGD' })).json<{
      id: string;
    }>().id;
    const short = await owner().post(`/sales-orders/${placed.id}/reserve`, {
      lines: [{ lineId, fulfilStoreId: empty }],
    });
    expect(refused(short).json<InsufficientStockRefusal>().code).toBe('insufficient_stock');
    expect((await view(placed.id)).lines[0]).toMatchObject({
      fulfilStoreId: b.stores.kkp,
      quantityReserved: 3,
    });

    // Cancelling what nothing holds releases nothing.
    const loose = await confirmed();
    ok(await owner().post(`/sales-orders/${loose.id}/release`, {}));
    const less = ok(
      await owner().post(`/sales-orders/${loose.id}/lines/${String(loose.lines[0]?.id)}/cancel`, {
        quantity: 1,
        reason: 'One less',
      }),
    ).json<SalesOrderView>();
    expect(less.lines[0]).toMatchObject({ quantityCancelled: 1, quantityReserved: 0 });

    const draft = await order();
    expect((await owner().post(`/sales-orders/${draft.id}/reserve`, {})).statusCode).toBe(409);
    expect((await owner().post(`/sales-orders/${draft.id}/release`, {})).statusCode).toBe(409);
    expect(
      (
        await owner().post(`/sales-orders/${draft.id}/lines/${String(draft.lines[0]?.id)}/cancel`, {
          reason: 'x y z',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('shows availability of every line at every store the member can see', async () => {
    const placed = await confirmed({
      lines: [{ variantId: b.apex, quantity: 2, fulfilStoreId: b.stores.kkp }],
    });
    const amp = await stock(b.stores.amp);
    const kkp = await stock(b.stores.kkp);
    const availability = ok(
      await owner().get(`/sales-orders/${placed.id}/availability`),
    ).json<OrderAvailabilityView>();
    expect(availability.lines).toEqual([
      expect.objectContaining({
        lineId: placed.lines[0]?.id,
        sku: 'APX-1L',
        fulfilStoreId: b.stores.kkp,
        quantityOpen: 2,
        quantityReserved: 2,
      }),
    ]);
    const stores = availability.lines[0]?.stores ?? [];
    expect(stores.map((store) => store.storeName)).toEqual([
      'Ameerpet',
      'Godown counter',
      'Kukatpally',
      'New godown',
    ]);
    expect(stores.find((store) => store.storeId === b.stores.amp)).toEqual({
      storeId: b.stores.amp,
      storeName: 'Ameerpet',
      onHand: amp.onHand,
      reserved: amp.reserved,
      available: amp.onHand - amp.reserved,
    });
    expect(stores.find((store) => store.storeId === b.stores.kkp)?.available).toBe(
      kkp.onHand - kkp.reserved,
    );
    expect(stores.find((store) => store.storeId === b.stores.unr)).toMatchObject({
      onHand: 0,
      reserved: 0,
      available: 0,
    });
    const kukatpally = await b.member('branch_manager', [b.stores.kkp]);
    expect(
      ok(await api(t, kukatpally).get(`/sales-orders/${placed.id}/availability`))
        .json<OrderAvailabilityView>()
        .lines[0]?.stores.map((store) => store.storeId),
    ).toEqual([b.stores.kkp]);
  });
});

describe('GET /sales-orders', () => {
  it('lists newest first with filters, by order store or fulfil store', async () => {
    const fresh = await billingBusiness(t);
    const o = api(t, fresh.owner);
    const make = async (body: object) =>
      ok(
        await o.post('/sales-orders', {
          storeId: fresh.stores.amp,
          billToPartyId: fresh.parties.homeowner,
          paymentTerms: 'prepaid',
          lines: [{ variantId: fresh.apex, quantity: 1 }],
          ...body,
        }),
      ).json<SalesOrderView>();
    const first = await make({});
    // A partial order with no advance setting needs none.
    const second = await make({ billToPartyId: fresh.parties.contractor, paymentTerms: 'partial' });
    ok(await o.post(`/sales-orders/${second.id}/confirm`, {}));
    const fromKukatpally = await make({
      lines: [{ variantId: fresh.apex, quantity: 1, fulfilStoreId: fresh.stores.kkp }],
    });
    const list = async (query = '', token = fresh.owner) =>
      ok(await api(t, token).get(`/sales-orders${query}`)).json<SalesOrderPage>();
    const ids = (page: SalesOrderPage) => page.items.map((item) => item.id);

    expect(ids(await list())).toEqual([fromKukatpally.id, second.id, first.id]);
    expect((await list()).items[1]).toMatchObject({
      number: second.number,
      status: 'confirmed',
      paymentTerms: 'partial',
      billToName: 'Deccan Contractors',
      totalPaise: 11_800,
      invoicedPaise: 0,
    });
    expect(ids(await list('?status=confirmed'))).toEqual([second.id]);
    expect(ids(await list(`?partyId=${fresh.parties.contractor}`))).toEqual([second.id]);
    expect(ids(await list(`?storeId=${fresh.stores.kkp}`))).toEqual([]);
    expect(ids(await list(`?projectId=${crypto.randomUUID()}`))).toEqual([]);
    expect(ids(await list('?q=deccan'))).toEqual([second.id]);
    expect(ids(await list(`?q=${first.number}`))).toEqual([first.id]);
    expect(ids(await list('?limit=1&offset=2'))).toEqual([first.id]);
    expect((await list()).total).toBe(3);

    const kukatpally = await fresh.member('sales_executive', [fresh.stores.kkp]);
    expect(ids(await list('', kukatpally))).toEqual([fromKukatpally.id]);
    expect((await api(t, kukatpally).get(`/sales-orders/${first.id}`)).statusCode).toBe(404);
    // Seen from a fulfil store, but changed only at the order's store.
    expect(
      (await api(t, kukatpally).post(`/sales-orders/${fromKukatpally.id}/confirm`, {})).statusCode,
    ).toBe(403);
  });
});
