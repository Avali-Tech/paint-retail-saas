import { migrateDatabase, schema } from '@paint/db';
import type {
  CreditApprovalDetail,
  CreditApprovalPage,
  CreditApprovalRefusal,
  CreditApprovalView,
  IssuedInvoiceView,
  PartyCreditSummary,
  SaleCreditView,
  SalesOrderView,
  TaxDocumentView,
} from '@paint/shared';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  ok,
  type BillingBusiness,
  type Reply,
} from '../test-support/billing-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';

const { auditLog, notifications, taxDocuments } = schema;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
/** Tokens and member ids of the staff at Ameerpet. */
let manager: string;
let sales: string;
let cashier: string;
let admin: string;
let kkpManager: string;
const members = new Map<string, string>();

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  manager = await b.member('branch_manager', [b.stores.amp]);
  sales = await b.member('sales_executive', [b.stores.amp]);
  cashier = await b.member('store_employee', [b.stores.amp]);
  admin = await b.member('org_admin', [b.stores.amp]);
  kkpManager = await b.member('branch_manager', [b.stores.kkp]);
  for (const token of [b.owner, manager, sales, cashier, admin, kkpManager]) {
    members.set(
      token,
      ok(await api(t, token).get('/auth/me')).json<{ memberId: string }>().memberId,
    );
  }
  // The admin works at every store.
  ok(await api(t, b.owner).patch(`/members/${memberId(admin)}`, { allStores: true }));
  // Billing goes live today: exposure comes from the ledger from now on.
  ok(await api(t, b.owner).post('/sales/go-live', {}));
  // Deccan Contractors gets a ₹30,000 limit the real way: a request the owner approves.
  const request = ok(
    await api(t, manager).post('/credit-requests', {
      partyId: b.parties.contractor,
      limitPaise: 3_000_000,
      creditDays: 30,
    }),
  ).json<{ id: string }>();
  ok(await api(t, b.owner).post(`/credit-requests/${request.id}/approve`, {}));
}, 240_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

const owner = () => api(t, b.owner);
const memberId = (token: string) => String(members.get(token));

/** A draft bill of one line worth exactly `paise`, tax inclusive. */
const draftWorth = (paise: number, body: object = {}, token = b.owner) =>
  b.draft(
    {
      partyId: b.parties.contractor,
      lines: [{ variantId: b.apex, quantity: 1, unitPricePaise: paise }],
      ...body,
    },
    token,
  );
const issue = (id: string, body: object = {}, token = b.owner) =>
  api(t, token).post(`/invoices/${id}/issue`, body);
const order = async (paise: number, body: object = {}, token = b.owner) =>
  ok(
    await api(t, token).post('/sales-orders', {
      storeId: b.stores.amp,
      billToPartyId: b.parties.contractor,
      paymentTerms: 'postpaid',
      lines: [{ variantId: b.apex, quantity: 1, unitPricePaise: paise }],
      ...body,
    }),
  ).json<SalesOrderView>();
const confirm = (id: string, body: object = {}, token = b.owner) =>
  api(t, token).post(`/sales-orders/${id}/confirm`, body);
const ask = (body: object, token = sales) => api(t, token).post('/credit-approvals', body);
const credit = async () =>
  ok(await owner().get(`/parties/${b.parties.contractor}/credit`)).json<PartyCreditSummary>();
let payments = 0;
/** A bank transfer from the contractor, set against its oldest bills (or kept as an advance). */
const pay = async (amountPaise: number, allocate = true) => {
  payments += 1;
  return ok(
    await owner().post('/payments', {
      storeId: b.stores.amp,
      partyId: b.parties.contractor,
      modeId: b.modes.bank.id,
      amountPaise,
      reference: `NEFT${String(payments)}`,
      ...(allocate ? {} : { allocations: [] }),
    }),
  );
};
/** Pays the contractor down until its exposure is `paise` (the tests share one party). */
const owe = async (paise: number) => {
  const { exposurePaise } = await credit();
  if (exposurePaise > paise) await pay(exposurePaise - paise);
  expect((await credit()).exposurePaise).toBe(paise);
};

function refusal(reply: Reply): CreditApprovalRefusal {
  expect(reply.statusCode, reply.body).toBe(409);
  return reply.json<CreditApprovalRefusal>();
}

async function noticesOf(token: string, event: string) {
  return t.connection.db
    .select({ title: notifications.title, body: notifications.body, link: notifications.link })
    .from(notifications)
    .where(
      and(eq(notifications.memberId, memberId(token)), eq(notifications.event, event as never)),
    )
    .orderBy(asc(notifications.createdAt));
}

describe('the spec §6.3 example through real invoices and payments (P2-M09 done when)', () => {
  it('asks the owner to approve ₹15,000 on a ₹30,000 limit with ₹18,000 outstanding', async () => {
    // ₹20,000 billed on account (67 % of the limit, within the normal share), ₹2,000 paid.
    const bill = await draftWorth(2_000_000);
    const billed = ok(await issue(bill.id)).json<IssuedInvoiceView>();
    expect(billed).toMatchObject({ totalPaise: 2_000_000, outstandingPaise: 2_000_000 });
    await pay(200_000);
    expect(await credit()).toMatchObject({
      exposureSource: 'ledger',
      exposurePaise: 1_800_000,
      exposure: { balancePaise: 1_800_000, openOrdersPaise: 0, advancePaise: 0 },
    });

    // The new order of ₹15,000: projected ₹33,000 = 110 % of the limit.
    const created = await order(1_500_000, {}, sales);
    const asked = refusal(await confirm(created.id, {}, sales));
    expect(asked).toMatchObject({
      code: 'credit_approval_required',
      credit: {
        exposureSource: 'ledger',
        position: { limitPaise: 3_000_000, exposurePaise: 1_800_000 },
        check: {
          decision: 'owner_approval',
          projectedExposurePaise: 3_300_000,
          utilizationPercent: 110,
        },
        approval: 'owner',
      },
      approval: null,
    });
    expect(asked.message).toBe(
      'This order takes the customer to 110% of their limit: the owner must approve',
    );

    // The sales executive asks; the request goes to the owner, not the branch manager.
    const request = ok(
      await ask({ salesOrderId: created.id, reason: 'Big site, pays every month' }),
    ).json<CreditApprovalView>();
    expect(request).toMatchObject({
      number: expect.stringMatching(/^AP-\d{6}$/),
      kind: 'sale',
      status: 'pending',
      level: 'owner',
      party: { id: b.parties.contractor, name: 'Deccan Contractors' },
      store: { id: b.stores.amp, name: 'Ameerpet' },
      subject: { type: 'sales_order', id: created.id, number: created.number },
      amountPaise: 1_500_000,
      reason: 'Big site, pays every month',
      checkAtRequest: { check: { utilizationPercent: 110 } },
      requestedBy: { memberId: memberId(sales), name: 'Staff sales_executive' },
      decidedBy: null,
      canDecide: false,
    });
    expect(await noticesOf(b.owner, 'credit_approval_requested')).toEqual([
      {
        title: `Credit approval ${request.number}: Deccan Contractors`,
        body: '₹15,000.00 on credit — Big site, pays every month',
        link: `/credit/approvals/${request.id}`,
      },
    ]);
    expect(await noticesOf(manager, 'credit_approval_requested')).toEqual([]);

    // Waiting: the order cannot be confirmed, and a manager cannot decide an owner-level sale.
    expect(refusal(await confirm(created.id, {}, sales))).toMatchObject({
      code: 'credit_approval_pending',
      message: `${request.number} is waiting for the owner to approve`,
      approval: { id: request.id, status: 'pending', level: 'owner' },
    });
    expect(
      (await api(t, manager).post(`/credit-approvals/${request.id}/approve`, {})).statusCode,
    ).toBe(403);
    expect(
      (await api(t, admin).post(`/credit-approvals/${request.id}/approve`, {})).statusCode,
    ).toBe(403);
    expect((await ask({ salesOrderId: created.id, reason: 'Again' })).statusCode).toBe(409);

    // The owner approves from the queue; the sales executive hears and confirms.
    const queue = ok(await owner().get('/credit-approvals?mine=true')).json<CreditApprovalPage>();
    expect(queue.items.map((item) => item.id)).toEqual([request.id]);
    expect(queue.items[0]?.canDecide).toBe(true);
    const approved = ok(
      await owner().post(`/credit-approvals/${request.id}/approve`, { reason: 'Known for years' }),
    ).json<CreditApprovalView>();
    expect(approved).toMatchObject({
      status: 'approved',
      decidedBy: { memberId: memberId(b.owner), name: 'Owner' },
      decisionReason: 'Known for years',
      canDecide: false,
    });
    expect(await noticesOf(sales, 'credit_approval_decided')).toEqual([
      expect.objectContaining({
        title: `Credit approval ${request.number} approved: Deccan Contractors`,
        body: '₹15,000.00 on credit\nKnown for years',
      }),
    ]);
    const done = ok(await confirm(created.id, {}, sales)).json<SalesOrderView>();
    expect(done).toMatchObject({
      status: 'confirmed',
      creditCheck: { decision: 'owner_approval', utilizationPercent: 110 },
      creditOverride: { approval: 'owner', memberName: 'Owner', reason: 'Known for years' },
      creditApproval: { id: request.id, status: 'used' },
    });
    const detail = ok(
      await owner().get(`/credit-approvals/${request.id}`),
    ).json<CreditApprovalDetail>();
    expect(detail).toMatchObject({ status: 'used', usedAt: expect.any(String), checkNow: null });

    // Every step is in the audit log.
    const audited = await t.connection.db
      .select({ action: auditLog.action, newValues: auditLog.newValues })
      .from(auditLog)
      .where(and(eq(auditLog.tableName, 'credit_approvals'), eq(auditLog.recordId, request.id)))
      .orderBy(asc(auditLog.id));
    expect(
      audited.map((row) => [row.action, (row.newValues as { status: string }).status]),
    ).toEqual([
      ['insert', 'pending'],
      ['update', 'approved'],
      ['update', 'used'],
    ]);
    const [orderAudit] = await t.connection.db
      .select({ newValues: auditLog.newValues })
      .from(auditLog)
      .where(and(eq(auditLog.tableName, 'sales_orders'), eq(auditLog.recordId, created.id)))
      .orderBy(asc(auditLog.id))
      .offset(1);
    expect(orderAudit?.newValues).toMatchObject({
      status: 'confirmed',
      credit_approval_id: request.id,
    });
  });
});

describe('approving in the dialog (the 2.0 override, now a recorded approval)', () => {
  it('lets the approver of the level confirm at once, recorded as an approval they gave', async () => {
    const created = await order(100_000, {}, manager);
    const preview = ok(
      await owner().get(`/sales-orders/${created.id}/credit-check`),
    ).json<SaleCreditView>();
    expect(preview.approval).toBe('owner');
    // A branch manager may approve only manager-level sales.
    expect(
      refusal(await confirm(created.id, { creditOverride: { reason: 'Please' } }, manager)),
    ).toMatchObject({
      code: 'credit_override_not_allowed',
      message: 'Only the owner can approve this order',
    });
    const done = ok(
      await confirm(created.id, { creditOverride: { reason: 'Pays on Friday' } }),
    ).json<SalesOrderView>();
    expect(done).toMatchObject({
      status: 'confirmed',
      creditOverride: { approval: 'owner', memberName: 'Owner', reason: 'Pays on Friday' },
      creditApproval: { status: 'used', level: 'owner', requestedBy: { name: 'Owner' } },
    });
  });

  it('records the request’s reason when the approver gives none', async () => {
    const created = await order(20_000, {}, sales);
    const request = ok(
      await ask({ salesOrderId: created.id, reason: 'Paint for the lobby' }),
    ).json<CreditApprovalView>();
    ok(await owner().post(`/credit-approvals/${request.id}/approve`, {}));
    const done = ok(await confirm(created.id, {}, sales)).json<SalesOrderView>();
    expect(done.creditOverride).toMatchObject({
      reason: 'Paint for the lobby',
      memberName: 'Owner',
    });
  });

  it('decides a pending request in the dialog, or replaces one at a lower level', async () => {
    const pendingOrder = await order(50_000, {}, sales);
    const pending = ok(
      await ask({ salesOrderId: pendingOrder.id, reason: 'Small top-up' }),
    ).json<CreditApprovalView>();
    const done = ok(
      await confirm(pendingOrder.id, { creditOverride: { reason: 'Fine by me' } }),
    ).json<SalesOrderView>();
    expect(done.creditApproval).toMatchObject({ id: pending.id, status: 'used' });
    expect(done.creditOverride).toMatchObject({ reason: 'Fine by me', memberName: 'Owner' });
  });
});

describe('issuing an invoice on credit (after go-live)', () => {
  it('refuses a bill on account to a customer without credit, and passes one paid in full', async () => {
    const unpaid = await b.draft({
      partyId: b.parties.homeowner,
      lines: [{ variantId: b.apex, quantity: 1 }],
    });
    expect(refusal(await issue(unpaid.id, { allocateAdvances: true }))).toMatchObject({
      code: 'credit_blocked',
      message: 'Credit is blocked for this customer (no credit)',
      credit: { check: { blockedBecause: 'no_credit', projectedExposurePaise: 11_800 } },
    });
    expect(
      (await ask({ invoiceId: unpaid.id, amountPaise: 11_800, reason: 'Please' })).statusCode,
    ).toBe(409);
    const paid = ok(
      await issue(unpaid.id, {
        payments: [{ modeId: b.modes.upi.id, amountPaise: 11_800, reference: 'UPI1' }],
      }),
    ).json<IssuedInvoiceView>();
    expect(paid.outstandingPaise).toBe(0);
    // Walk-in bills are always paid in full: never checked.
    const walkIn = await b.draft({ lines: [{ variantId: b.apex, quantity: 1 }] });
    expect(
      (await owner().get(`/invoices/${walkIn.id}/credit-check?unpaidPaise=11800`)).statusCode,
    ).toBe(409);
    ok(
      await issue(walkIn.id, {
        payments: [{ modeId: b.modes.upi.id, amountPaise: 11_800, reference: 'UPI2' }],
      }),
    );
  });

  it('routes a manager-level bill to the store’s managers, then issues it with the approval', async () => {
    await owe(1_000_000);
    const bill = await draftWorth(1_500_000, {}, cashier);
    const preview = ok(
      await api(t, cashier).get(`/invoices/${bill.id}/credit-check?unpaidPaise=1500000`),
    ).json<SaleCreditView>();
    expect(preview).toMatchObject({
      required: true,
      check: { decision: 'manager_approval', utilizationPercent: 83.33 },
      approval: 'manager',
    });
    expect(refusal(await issue(bill.id, {}, cashier))).toMatchObject({
      code: 'credit_approval_required',
      message: 'This bill takes the customer to 83.33% of their limit: a manager must approve',
    });
    // The store employee asks at the counter.
    const request = ok(
      await ask(
        { invoiceId: bill.id, amountPaise: 1_500_000, reason: 'Regular contractor' },
        cashier,
      ),
    ).json<CreditApprovalView>();
    expect(request).toMatchObject({
      level: 'manager',
      subject: { type: 'tax_document', id: bill.id, number: null },
    });
    expect(await noticesOf(manager, 'credit_approval_requested')).toHaveLength(1);
    expect(await noticesOf(kkpManager, 'credit_approval_requested')).toEqual([]);
    // Kukatpally’s manager is not at this store: they may see the business-wide party, not decide.
    expect(
      (await api(t, kkpManager).post(`/credit-approvals/${request.id}/approve`, {})).statusCode,
    ).toBe(403);
    const queue = ok(
      await api(t, manager).get('/credit-approvals?mine=true'),
    ).json<CreditApprovalPage>();
    expect(queue.items.map((item) => item.id)).toEqual([request.id]);
    ok(await api(t, manager).post(`/credit-approvals/${request.id}/approve`, {}));
    // Paying part at the counter only lowers what is checked: the approval still covers it.
    const issued = ok(
      await issue(
        bill.id,
        { payments: [{ modeId: b.modes.upi.id, amountPaise: 50_000, reference: 'UPI3' }] },
        cashier,
      ),
    ).json<IssuedInvoiceView>();
    expect(issued.outstandingPaise).toBe(1_450_000);
    const [stored] = await t.connection.db
      .select({ check: taxDocuments.creditCheck, approvalId: taxDocuments.creditApprovalId })
      .from(taxDocuments)
      .where(eq(taxDocuments.id, bill.id));
    expect(stored).toMatchObject({
      approvalId: request.id,
      check: { approval: 'manager', check: { projectedExposurePaise: 2_450_000 } },
    });
  });

  it('asks again when the approval no longer covers the bill', async () => {
    await owe(2_350_000);
    const bill = await draftWorth(100_000);
    const request = ok(
      await ask({ invoiceId: bill.id, amountPaise: 100_000, reason: 'Small' }),
    ).json<CreditApprovalView>();
    expect(request.level).toBe('manager');
    ok(await api(t, manager).post(`/credit-approvals/${request.id}/approve`, {}));
    // Another bill is issued meanwhile (approved in the dialog by the manager).
    const other = await draftWorth(100_000);
    ok(await issue(other.id, { creditOverride: { reason: 'Counter rush' } }, manager));
    expect(refusal(await issue(bill.id))).toMatchObject({
      code: 'credit_approval_stale',
      message: `${request.number} no longer covers this bill: ask again`,
      approval: { id: request.id, status: 'approved' },
    });
    // Approving in the dialog replaces what no longer covers it, as a new request would.
    const dialog = await draftWorth(100_000);
    const old = ok(
      await ask({ invoiceId: dialog.id, amountPaise: 100_000, reason: 'Old' }),
    ).json<CreditApprovalView>();
    ok(await api(t, manager).post(`/credit-approvals/${old.id}/approve`, {}));
    const raise = await draftWorth(100_000);
    ok(await issue(raise.id, { creditOverride: { reason: 'Counter rush' } }));
    ok(await issue(dialog.id, { creditOverride: { reason: 'Owner says yes' } }));
    expect(
      ok(await owner().get(`/credit-approvals/${old.id}`)).json<CreditApprovalDetail>().status,
    ).toBe('cancelled');
    // A new request replaces it.
    const again = ok(
      await ask({ invoiceId: bill.id, amountPaise: 100_000, reason: 'Again' }),
    ).json<CreditApprovalView>();
    const replaced = ok(
      await owner().get(`/credit-approvals/${request.id}`),
    ).json<CreditApprovalDetail>();
    expect(replaced.status).toBe('cancelled');
    // While it waits, the queue shows where the bill stands now.
    const waiting = ok(
      await owner().get(`/credit-approvals/${again.id}`),
    ).json<CreditApprovalDetail>();
    expect(waiting.checkNow).toMatchObject({ required: true, approval: 'manager' });
    expect(
      (
        await owner().post(`/credit-approvals/${again.id}/approve`, {
          waiveOverdueUntil: '2026-12-31',
        })
      ).statusCode,
    ).toBe(409);
    expect((await api(t, sales).post(`/credit-approvals/${again.id}/approve`, {})).statusCode).toBe(
      403,
    );
    ok(await owner().post(`/credit-approvals/${again.id}/approve`, {}));
    ok(await issue(bill.id));
  });

  it('does not check a bill of a postpaid order, nor one the customer’s advance pays', async () => {
    const created = await order(10_000);
    ok(await confirm(created.id, { creditOverride: { reason: 'Owner here' } }));
    const fromOrder = ok(
      await owner().post(`/sales-orders/${created.id}/invoices`, {}),
    ).json<TaxDocumentView>();
    expect(
      (await ask({ invoiceId: fromOrder.id, amountPaise: 10_000, reason: 'Checked at confirm' }))
        .statusCode,
    ).toBe(409);
    ok(await issue(fromOrder.id));
    // A prepaid order's bill is paid in full: not credit either.
    const prepaid = await order(10_000, { paymentTerms: 'prepaid' });
    ok(await confirm(prepaid.id));
    const prepaidBill = ok(
      await owner().post(`/sales-orders/${prepaid.id}/invoices`, {}),
    ).json<TaxDocumentView>();
    ok(
      await issue(prepaidBill.id, {
        payments: [{ modeId: b.modes.upi.id, amountPaise: 10_000, reference: 'UPI-PRE' }],
      }),
    );
    await owe(1_000_000);
    await pay(50_000, false);
    const covered = await draftWorth(50_000);
    expect(
      ok(
        await owner().get(`/invoices/${covered.id}/credit-check?unpaidPaise=0`),
      ).json<SaleCreditView>(),
    ).toMatchObject({ required: false, check: null, approval: 'none' });
    expect(
      ok(await issue(covered.id, { allocateAdvances: true })).json<IssuedInvoiceView>(),
    ).toMatchObject({
      outstandingPaise: 0,
    });
    expect(
      (await owner().get(`/invoices/${covered.id}/credit-check?unpaidPaise=0`)).statusCode,
    ).toBe(409);
    expect(
      (await ask({ invoiceId: fromOrder.id, amountPaise: 100, reason: 'Already issued' }))
        .statusCode,
    ).toBe(409);
  });

  it('lets only one of two bills at once use the last of the limit', async () => {
    // ₹10,000 owed: one ₹8,000 bill stays within 80 % (₹18,000), two would not (₹26,000).
    await owe(1_000_000);
    const first = await draftWorth(800_000);
    const second = await draftWorth(800_000);
    // Hold the party's balance row so both issues queue behind it, then let them race.
    const results = await withPgClient(database.connectionString, async (client) => {
      await client.query('begin');
      await client.query('select 1 from party_balances where party_id = $1 for update', [
        b.parties.contractor,
      ]);
      const racing = Promise.all([issue(first.id), issue(second.id)]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await client.query('commit');
      return racing;
    });
    expect(results.map((reply) => reply.statusCode).sort()).toEqual([200, 409]);
  });
});

describe('the approval queue', () => {
  it('lists, rejects with a reason, and lets the requester cancel', async () => {
    const created = await order(5_000_000, {}, sales);
    const request = ok(
      await ask({ salesOrderId: created.id, reason: 'Huge job' }),
    ).json<CreditApprovalView>();
    const detail = ok(
      await api(t, manager).get(`/credit-approvals/${request.id}`),
    ).json<CreditApprovalDetail>();
    expect(detail).toMatchObject({
      status: 'pending',
      checkNow: { approval: 'owner' },
      canDecide: false,
    });
    expect((await owner().post(`/credit-approvals/${request.id}/reject`, {})).statusCode).toBe(400);
    const rejected = ok(
      await owner().post(`/credit-approvals/${request.id}/reject`, { reason: 'Too much at once' }),
    ).json<CreditApprovalView>();
    expect(rejected).toMatchObject({ status: 'rejected', decisionReason: 'Too much at once' });
    expect((await owner().post(`/credit-approvals/${request.id}/approve`, {})).statusCode).toBe(
      409,
    );
    expect((await owner().post(`/credit-approvals/${request.id}/cancel`, {})).statusCode).toBe(409);
    // Rejected: the order still needs an approval.
    expect(refusal(await confirm(created.id, {}, sales)).code).toBe('credit_approval_required');

    const again = ok(
      await ask({ salesOrderId: created.id, reason: 'Smaller now' }),
    ).json<CreditApprovalView>();
    expect(
      (await api(t, cashier).post(`/credit-approvals/${again.id}/cancel`, {})).statusCode,
    ).toBe(403);
    expect((await api(t, sales).post(`/credit-approvals/${again.id}/approve`, {})).statusCode).toBe(
      403,
    );
    const cancelled = ok(
      await api(t, sales).post(`/credit-approvals/${again.id}/cancel`, {}),
    ).json<CreditApprovalView>();
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      decidedBy: { name: 'Staff sales_executive' },
    });

    const all = ok(
      await owner().get(`/credit-approvals?partyId=${b.parties.contractor}&limit=200`),
    ).json<CreditApprovalPage>();
    expect(all.items[0]?.id).toBe(again.id);
    const rejectedOnly = ok(
      await owner().get('/credit-approvals?status=rejected&kind=sale'),
    ).json<CreditApprovalPage>();
    expect(rejectedOnly.items.map((item) => item.id)).toEqual([request.id]);
    expect(rejectedOnly.total).toBe(1);
    expect((await api(t, cashier).get('/credit-approvals')).statusCode).toBe(403);
    expect((await owner().get(`/credit-approvals/${crypto.randomUUID()}`)).statusCode).toBe(404);
    expect(
      (await owner().post(`/credit-approvals/${crypto.randomUUID()}/cancel`, {})).statusCode,
    ).toBe(404);
    // Each member's queue holds only what they may decide.
    const pendingOwner = await order(5_000_000, {}, sales);
    const ownerLevel = ok(
      await ask({ salesOrderId: pendingOwner.id, reason: 'For the owner' }),
    ).json<CreditApprovalView>();
    const queueOf = async (token: string) =>
      ok(await api(t, token).get('/credit-approvals?mine=true'))
        .json<CreditApprovalPage>()
        .items.map((item) => item.id);
    expect(await queueOf(b.owner)).toContain(ownerLevel.id);
    expect(await queueOf(admin)).not.toContain(ownerLevel.id);
    expect(await queueOf(manager)).not.toContain(ownerLevel.id);
    expect(await queueOf(sales)).toEqual([]);
  });

  it('cancels an approved approval that was never used, and discarding the draft removes them', async () => {
    const bill = await draftWorth(5_000_000);
    const request = ok(
      await ask({ invoiceId: bill.id, amountPaise: 5_000_000, reason: 'Later' }),
    ).json<CreditApprovalView>();
    ok(await owner().post(`/credit-approvals/${request.id}/approve`, {}));
    const cancelled = ok(
      await owner().post(`/credit-approvals/${request.id}/cancel`, {}),
    ).json<CreditApprovalView>();
    expect(cancelled).toMatchObject({ status: 'cancelled', decidedBy: { name: 'Owner' } });
    expect(refusal(await issue(bill.id)).code).toBe('credit_approval_required');
    const another = ok(
      await ask({ invoiceId: bill.id, amountPaise: 5_000_000, reason: 'Now' }),
    ).json<CreditApprovalView>();
    ok(await owner().delete(`/invoices/${bill.id}`));
    expect((await owner().get(`/credit-approvals/${another.id}`)).statusCode).toBe(404);
  });

  it('refuses requests that need no approval, or are not sales on credit', async () => {
    const prepaid = await order(10_000, { paymentTerms: 'prepaid' });
    expect((await ask({ salesOrderId: prepaid.id, reason: 'x x x' })).statusCode).toBe(409);
    const small = await draftWorth(100);
    ok(await pay(10_000_000));
    const notNeeded = refusal(
      await ask({ invoiceId: small.id, amountPaise: 100, reason: 'Small' }),
    );
    expect(notNeeded).toMatchObject({ code: 'credit_approval_not_needed' });
    // A cashier cannot ask for an order, nor a sales executive for a release.
    const draftOrder = await order(10_000);
    expect((await ask({ salesOrderId: draftOrder.id, reason: 'Please' }, cashier)).statusCode).toBe(
      403,
    );
    expect(
      (await ask({ invoiceId: small.id, amountPaise: 100, reason: 'Please' }, admin)).statusCode,
    ).toBe(409);
    const confirmedOrder = ok(await confirm(draftOrder.id)).json<SalesOrderView>();
    expect((await ask({ salesOrderId: confirmedOrder.id, reason: 'Late' })).statusCode).toBe(409);
    expect(
      (await ask({ kind: 'release', partyId: b.parties.contractor, reason: 'Release' }, cashier))
        .statusCode,
    ).toBe(403);
    expect(
      (await ask({ kind: 'release', partyId: crypto.randomUUID(), reason: 'Release' })).statusCode,
    ).toBe(404);
    const crm = await b.member('crm_executive', [b.stores.amp]);
    expect(
      (await ask({ invoiceId: small.id, amountPaise: 100, reason: 'Please' }, crm)).statusCode,
    ).toBe(403);
    expect((await ask({ salesOrderId: draftOrder.id })).statusCode).toBe(400);
  });
});
