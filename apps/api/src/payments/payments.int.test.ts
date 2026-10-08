import {
  findAllocationMismatches,
  findPartyBalanceMismatches,
  migrateDatabase,
  schema,
} from '@paint/db';
import type {
  IssuedInvoiceView,
  NotificationPage,
  PartyLedgerView,
  PaymentModeView,
  PaymentPage,
  PaymentView,
  ReceiptView,
  RecordPaymentRequest,
  RegisterSessionView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  dbToday,
  issuesOf,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';

const { partyBalances } = schema;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let today: string;
/** The open register at Ameerpet, so cash can be taken there. */
let counter: RegisterSessionView;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  today = await dbToday(t);
  counter = ok(
    await api(t, b.owner).post('/registers/counter1/open', {
      storeId: b.stores.amp,
      openingFloatPaise: 100_000,
    }),
  ).json<RegisterSessionView>();
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

const owner = () => api(t, b.owner);
const pay = (body: Partial<RecordPaymentRequest>, headers: Record<string, string> = {}) =>
  api(t, b.owner, headers).post('/payments', {
    storeId: b.stores.amp,
    partyId: b.parties.contractor,
    modeId: b.modes.upi.id,
    ...body,
  });
const paid = async (body: Partial<RecordPaymentRequest>) => ok(await pay(body)).json<PaymentView>();
const ledgerOf = async (partyId: string, query = '') =>
  ok(await owner().get(`/parties/${partyId}/ledger${query}`)).json<PartyLedgerView>();
const outstandingOf = async (partyId: string, documentId: string) =>
  (await ledgerOf(partyId)).openDocuments.find((d) => d.documentId === documentId)
    ?.outstandingPaise ?? 0;

/** A new customer with nothing owed yet. */
async function customer(name: string): Promise<string> {
  return ok(await owner().post('/parties', { displayName: name, roles: ['contractor'] })).json<{
    id: string;
  }>().id;
}

describe('payment modes', () => {
  it('starts with the five base modes, and adds, renames and switches off others', async () => {
    const modes = ok(await owner().get('/payment-modes')).json<PaymentModeView[]>();
    expect(modes.map((m) => [m.kind, m.name, m.isActive])).toEqual([
      ['cash', 'Cash', true],
      ['upi', 'UPI', true],
      ['card', 'Card', true],
      ['bank_transfer', 'Bank transfer', true],
      ['cheque', 'Cheque', true],
    ]);
    const finance = ok(
      await owner().post('/payment-modes', { kind: 'other', name: 'Bajaj Finance' }),
    ).json<PaymentModeView>();
    expect((await owner().post('/payment-modes', { kind: 'upi', name: 'upi' })).statusCode).toBe(
      409,
    );
    expect(
      ok(await owner().patch(`/payment-modes/${finance.id}`, { name: 'Bajaj Finserv' })).json(),
    ).toMatchObject({ name: 'Bajaj Finserv', isActive: true });
    expect((await owner().patch(`/payment-modes/${finance.id}`, { name: 'Card' })).statusCode).toBe(
      409,
    );
    expect(
      (await owner().patch(`/payment-modes/${crypto.randomUUID()}`, { isActive: false }))
        .statusCode,
    ).toBe(404);
    ok(await owner().patch(`/payment-modes/${finance.id}`, { isActive: false }));
    expect(issuesOf(await pay({ modeId: finance.id, amountPaise: 100 }))).toEqual(['modeId']);
    const list = ok(await owner().get('/payment-modes')).json<PaymentModeView[]>();
    expect(list.at(-1)).toMatchObject({ name: 'Bajaj Finserv', isActive: false });

    const cashier = await b.member('store_employee', [b.stores.amp]);
    expect((await api(t, cashier).get('/payment-modes')).statusCode).toBe(200);
    expect(
      (await api(t, cashier).post('/payment-modes', { kind: 'other', name: 'Wallet' })).statusCode,
    ).toBe(403);
  });
});

describe('recording payments', () => {
  it('pays the oldest bills first and keeps the rest as an advance with a receipt voucher', async () => {
    const party = await customer('Ravi Constructions');
    const first = await b.invoice({ partyId: party });
    const second = await b.invoice({ partyId: party, quantity: 2 });
    const payment = await paid({ partyId: party, amountPaise: 50_000, reference: 'UTR123' });

    expect(payment).toMatchObject({
      number: expect.stringMatching(/^RC-\d{6}$/),
      voucherNumber: expect.stringMatching(/^AMPA\/\d{2}-\d{2}\/\d{5}$/),
      direction: 'in',
      partyName: 'Ravi Constructions',
      mode: { kind: 'upi', name: 'UPI' },
      amountPaise: 50_000,
      receivedOn: today,
      reference: 'UTR123',
      chequeStatus: null,
      registerSessionId: null,
      unallocatedPaise: 50_000 - 11_800 - 23_600,
      changePaise: null,
    });
    expect(payment.allocations.map((a) => [a.documentId, a.targetNumber, a.amountPaise])).toEqual([
      [first.id, first.number, 11_800],
      [second.id, second.number, 23_600],
    ]);
    const ledger = await ledgerOf(party);
    expect(ledger).toMatchObject({
      openingPaise: 0,
      balancePaise: 35_400 - 50_000,
      closingPaise: 35_400 - 50_000,
      advancePaise: 14_600,
      openDocuments: [],
    });
    expect(ledger.entries.map((e) => [e.entryType, e.amountPaise, e.balancePaise])).toEqual([
      ['invoice', 11_800, 11_800],
      ['invoice', 23_600, 35_400],
      ['payment_in', -50_000, -14_600],
    ]);
  });

  it('pays the bills chosen, within what is due and what the payment has', async () => {
    const party = await customer('Choice Builders');
    const first = await b.invoice({ partyId: party });
    const second = await b.invoice({ partyId: party });
    const payment = await paid({
      partyId: party,
      amountPaise: 11_800,
      allocations: [{ documentId: second.id, amountPaise: 11_800 }],
    });
    expect(payment.voucherNumber).toBeNull();
    expect(payment.allocations.map((a) => a.documentId)).toEqual([second.id]);
    expect(await outstandingOf(party, first.id)).toBe(11_800);

    const refused = async (allocations: object[], amountPaise = 11_800) =>
      issuesOf(await pay({ partyId: party, amountPaise, allocations } as never));
    expect(await refused([{ documentId: second.id, amountPaise: 1 }])).toEqual(['allocations.0']);
    expect(
      await refused([
        { documentId: first.id, amountPaise: 100 },
        { documentId: first.id, amountPaise: 100 },
      ]),
    ).toEqual(['allocations.1']);
    expect(await refused([{ documentId: first.id, amountPaise: 11_801 }], 20_000)).toEqual([
      'allocations.0.amountPaise',
    ]);
    expect(await refused([{ documentId: first.id, amountPaise: 11_800 }], 100)).toEqual([
      'allocations.0.amountPaise',
    ]);
    expect(
      await refused([{ documentId: first.id, partyLedgerId: first.id, amountPaise: 1 }]),
    ).toEqual(['allocations.0.documentId']);

    // Everything kept as an advance; no bills paid.
    const advance = await paid({ partyId: party, amountPaise: 500, allocations: [] });
    expect(advance).toMatchObject({ unallocatedPaise: 500, allocations: [] });

    // Oldest first stops when the money runs out.
    const third = await b.invoice({ partyId: party });
    const oldest = await paid({ partyId: party, amountPaise: 11_800 });
    expect(oldest.allocations.map((row) => row.documentId)).toEqual([first.id]);
    expect(await outstandingOf(party, third.id)).toBe(11_800);
  });

  it('numbers receipts gap-free and returns the first response to a repeated request', async () => {
    const party = await customer('Repeat Traders');
    const key = { 'idempotency-key': `pay-${crypto.randomUUID()}` };
    const body = { partyId: party, amountPaise: 1_000, allocations: [] };
    const first = ok(await pay(body, key)).json<PaymentView>();
    const again = ok(await pay(body, key)).json<PaymentView>();
    expect(again).toEqual(first);
    expect((await pay({ ...body, amountPaise: 2_000 }, key)).statusCode).toBe(422);
    const next = await paid(body);
    expect(Number(next.number.slice(3))).toBe(Number(first.number.slice(3)) + 1);
    expect((await ledgerOf(party)).balancePaise).toBe(-2_000);
  });

  it('refuses walk-ins, unknown parties, stores and modes, and details a mode does not take', async () => {
    await b.invoice(); // creates the walk-in customer
    const { walkInPartyId: walkIn } = ok(await owner().get('/sales/settings')).json<{
      walkInPartyId: string;
    }>();
    expect(issuesOf(await pay({ partyId: walkIn, amountPaise: 100 }))).toEqual(['partyId']);
    expect(issuesOf(await pay({ partyId: crypto.randomUUID(), amountPaise: 100 }))).toEqual([
      'partyId',
    ]);
    expect(issuesOf(await pay({ storeId: crypto.randomUUID(), amountPaise: 100 }))).toEqual([
      'storeId',
    ]);
    expect(issuesOf(await pay({ modeId: crypto.randomUUID(), amountPaise: 100 }))).toEqual([
      'modeId',
    ]);
    expect(issuesOf(await pay({ modeId: b.modes.cheque.id, amountPaise: 100 }))).toEqual([
      'reference',
    ]);
    expect(issuesOf(await pay({ amountPaise: 100, chequeDate: today }))).toEqual(['chequeDate']);
    expect(issuesOf(await pay({ amountPaise: 100, tenderedPaise: 200 }))).toEqual([
      'tenderedPaise',
    ]);
    expect(
      issuesOf(await pay({ modeId: b.modes.cash.id, amountPaise: 100, tenderedPaise: 50 })),
    ).toEqual(['tenderedPaise']);
    expect(issuesOf(await pay({ amountPaise: 100, receivedOn: await dbToday(t, 1) }))).toEqual([
      'receivedOn',
    ]);
    const elsewhere = await b.member('sales_executive', [b.stores.kkp]);
    expect(
      (
        await api(t, elsewhere).post('/payments', {
          storeId: b.stores.amp,
          partyId: b.parties.contractor,
          modeId: b.modes.upi.id,
          amountPaise: 100,
        })
      ).statusCode,
    ).toBe(403);
    const cashier = await b.member('store_employee', [b.stores.amp]);
    expect(
      (
        await api(t, cashier).post('/payments', {
          storeId: b.stores.amp,
          partyId: b.parties.contractor,
          modeId: b.modes.upi.id,
          amountPaise: 100,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('takes cash into the open register, with change, and issues no voucher at an unregistered store', async () => {
    const party = await customer('Cash Painter');
    const cash = await paid({
      partyId: party,
      modeId: b.modes.cash.id,
      amountPaise: 1_500,
      tenderedPaise: 2_000,
      allocations: [],
    });
    expect(cash).toMatchObject({
      registerSessionId: counter.id,
      tenderedPaise: 2_000,
      changePaise: 500,
      voucherNumber: expect.stringMatching(/^AMPA\//),
    });
    const unregistered = await paid({
      partyId: party,
      storeId: b.stores.unr,
      amountPaise: 700,
      allocations: [],
    });
    expect(unregistered.voucherNumber).toBeNull();
    expect(
      (
        await pay({
          partyId: party,
          storeId: b.stores.kkp,
          modeId: b.modes.cash.id,
          amountPaise: 1,
        })
      ).statusCode,
    ).toBe(409);
  });
});

describe('allocating and undoing', () => {
  it('allocates an advance later, undoes one allocation and allocates it again', async () => {
    const party = await customer('Later Builders');
    const advance = await paid({ partyId: party, amountPaise: 30_000, allocations: [] });
    const allocate = (body: object = {}) => owner().post(`/payments/${advance.id}/allocate`, body);
    expect((await allocate()).statusCode).toBe(409); // nothing due yet
    const first = await b.invoice({ partyId: party });
    const second = await b.invoice({ partyId: party });
    const after = ok(
      await allocate({ allocations: [{ documentId: second.id, amountPaise: 5_000 }] }),
    ).json<PaymentView>();
    expect(after.unallocatedPaise).toBe(25_000);
    const auto = ok(await allocate()).json<PaymentView>();
    expect(auto.allocations.map((a) => [a.documentId, a.amountPaise])).toEqual([
      [second.id, 5_000],
      [first.id, 11_800],
      [second.id, 6_800],
    ]);
    expect(auto.unallocatedPaise).toBe(30_000 - 23_600);

    const [row] = auto.allocations;
    const reverse = (allocationId = String(row?.id), paymentId = advance.id) =>
      owner().post(`/payments/${paymentId}/allocations/${allocationId}/reverse`);
    const undone = ok(await reverse()).json<PaymentView>();
    expect(undone.unallocatedPaise).toBe(30_000 - 23_600 + 5_000);
    expect(undone.allocations.find((a) => a.id === row?.id)?.reversed).toBe(true);
    expect((await reverse()).statusCode).toBe(409);
    const reversal = undone.allocations.find((a) => a.reversesAllocationId === row?.id);
    expect(issuesOf(await reverse(String(reversal?.id)))).toEqual(['allocationId']);
    expect(issuesOf(await reverse(crypto.randomUUID()))).toEqual(['allocationId']);
    expect(await outstandingOf(party, second.id)).toBe(5_000);
    ok(await allocate({ allocations: [{ documentId: second.id, amountPaise: 5_000 }] }));

    const done = ok(await owner().get(`/payments/${advance.id}`)).json<PaymentView>();
    expect(done.unallocatedPaise).toBe(6_400);
    await b.invoice({ partyId: party });
    const exact = await paid({ partyId: party, amountPaise: 11_800 - 6_400, allocations: [] });
    ok(await allocate());
    ok(await owner().post(`/payments/${exact.id}/allocate`));
    expect((await owner().post(`/payments/${exact.id}/allocate`)).statusCode).toBe(409);
    expect((await owner().post(`/payments/${crypto.randomUUID()}/allocate`)).statusCode).toBe(404);
  });

  it('lets only one of two payments racing for the same invoice take it', async () => {
    const party = await customer('Racing Traders');
    const bill = await b.invoice({ partyId: party, quantity: 3 });
    const first = await paid({ partyId: party, amountPaise: 35_400, allocations: [] });
    const second = await paid({ partyId: party, amountPaise: 35_400, allocations: [] });
    const body = { allocations: [{ documentId: bill.id, amountPaise: 35_400 }] };
    const replies = await Promise.all([
      owner().post(`/payments/${first.id}/allocate`, body),
      owner().post(`/payments/${second.id}/allocate`, body),
    ]);
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 422]);
    expect(await outstandingOf(party, bill.id)).toBe(0);
    const ledger = await ledgerOf(party);
    expect(ledger.advancePaise).toBe(35_400);
    expect(ledger.balancePaise).toBe(-35_400);
  });

  it('keeps a paid invoice from being cancelled until its allocations are undone', async () => {
    const party = await customer('Cancel Check');
    const bill = await b.invoice({ partyId: party });
    const payment = await paid({ partyId: party, amountPaise: 11_800 });
    const cancel = () => owner().post(`/invoices/${bill.id}/cancel`, { reason: 'Wrong customer' });
    expect((await cancel()).statusCode).toBe(409);
    ok(
      await owner().post(
        `/payments/${payment.id}/allocations/${String(payment.allocations[0]?.id)}/reverse`,
      ),
    );
    ok(await cancel());
    expect(await ledgerOf(party)).toMatchObject({ balancePaise: -11_800, advancePaise: 11_800 });
  });
});

describe('cheques', () => {
  it('clears a cheque once, on a date from receipt to today', async () => {
    const party = await customer('Cheque Clear');
    const cheque = await paid({
      partyId: party,
      modeId: b.modes.cheque.id,
      amountPaise: 10_000,
      reference: '004512',
      chequeDate: today,
      allocations: [],
    });
    expect(cheque.chequeStatus).toBe('pending');
    const clear = (body: object) => owner().post(`/payments/${cheque.id}/clear`, body);
    expect(issuesOf(await clear({ clearedOn: await dbToday(t, 1) }))).toEqual(['clearedOn']);
    expect(issuesOf(await clear({ clearedOn: await dbToday(t, -1) }))).toEqual(['clearedOn']);
    expect(ok(await clear({})).json<PaymentView>()).toMatchObject({
      chequeStatus: 'cleared',
      chequeClearedOn: today,
    });
    expect((await clear({})).statusCode).toBe(409);
    expect(
      (await owner().post(`/payments/${cheque.id}/bounce`, { reason: 'Funds' })).statusCode,
    ).toBe(409);
  });

  it('bounces a cheque: allocations undone, the balance back up, a charge on top, managers told', async () => {
    const party = await customer('Bounce Builders');
    await b.invoice({ partyId: party, quantity: 2 });
    const manager = await b.member('branch_manager', [b.stores.amp]);
    const cheque = await paid({
      partyId: party,
      modeId: b.modes.cheque.id,
      amountPaise: 30_000,
      reference: '778899',
      chequeDate: today,
    });
    expect(cheque.unallocatedPaise).toBe(30_000 - 23_600);
    const before = await ledgerOf(party);
    expect(before.balancePaise).toBe(-6_400);

    const bounced = ok(
      await owner().post(`/payments/${cheque.id}/bounce`, {
        reason: 'Insufficient funds',
        chargePaise: 50_000,
      }),
    ).json<PaymentView>();
    expect(bounced).toMatchObject({
      chequeStatus: 'bounced',
      chequeBouncedOn: today,
      bounceReason: 'Insufficient funds',
      unallocatedPaise: 0,
    });
    expect(bounced.allocations.map((a) => a.amountPaise)).toEqual([23_600, -23_600]);
    const after = await ledgerOf(party);
    expect(after).toMatchObject({ balancePaise: 23_600 + 50_000, advancePaise: 0 });
    expect(after.entries.slice(-2).map((e) => [e.entryType, e.amountPaise])).toEqual([
      ['cheque_bounce', 30_000],
      ['adjustment', 50_000],
    ]);
    expect(after.openDocuments.map((d) => [d.kind, d.outstandingPaise])).toEqual([
      ['invoice', 23_600],
      ['charge', 50_000],
    ]);
    const notices = ok(await api(t, manager).get('/notifications')).json<NotificationPage>();
    expect(notices.items[0]).toMatchObject({
      event: 'cheque_bounced',
      title: 'Cheque bounced: Bounce Builders',
      link: `/payments/${cheque.id}`,
    });
    // The bounced cheque is dead money; the charge is paid like a bill.
    expect((await owner().post(`/payments/${cheque.id}/allocate`)).statusCode).toBe(409);
    const charge = after.openDocuments.find((d) => d.kind === 'charge');
    const settled = await paid({
      partyId: party,
      amountPaise: 50_000,
      allocations: [{ partyLedgerId: String(charge?.partyLedgerId), amountPaise: 50_000 }],
    });
    expect(settled.allocations[0]?.targetNumber).toMatch(/^Cheque bounce charge/);

    // A cheque that paid nothing bounces without allocations or a charge.
    const loose = await paid({
      partyId: party,
      modeId: b.modes.cheque.id,
      amountPaise: 1_000,
      reference: '000001',
      chequeDate: today,
      allocations: [],
    });
    ok(await owner().post(`/payments/${loose.id}/bounce`, { reason: 'Signature' }));
    expect(await ledgerOf(party)).toMatchObject({ balancePaise: 23_600, advancePaise: 0 });
  });
});

describe('refunds', () => {
  it('pays back an advance, with a refund voucher, and cash out of the register', async () => {
    const party = await customer('Refund Painter');
    const advance = await paid({ partyId: party, amountPaise: 20_000, allocations: [] });
    const refund = (body: object, headers: Record<string, string> = {}) =>
      api(t, b.owner, headers).post(`/payments/${advance.id}/refund`, {
        modeId: b.modes.cash.id,
        ...body,
      });
    expect(issuesOf(await refund({ amountPaise: 20_001 }))).toEqual(['amountPaise']);
    expect(issuesOf(await refund({ amountPaise: 100, paidOn: await dbToday(t, -1) }))).toEqual([
      'paidOn',
    ]);
    const key = { 'idempotency-key': `refund-${crypto.randomUUID()}` };
    const back = ok(
      await refund({ amountPaise: 5_000, note: 'Order reduced' }, key),
    ).json<PaymentView>();
    expect(ok(await refund({ amountPaise: 5_000, note: 'Order reduced' }, key)).json()).toEqual(
      back,
    );
    expect(back).toMatchObject({
      number: expect.stringMatching(/^RF-\d{6}$/),
      voucherNumber: expect.stringMatching(/^AMPR\//),
      direction: 'out',
      amountPaise: 5_000,
      registerSessionId: counter.id,
      unallocatedPaise: 0,
    });
    expect(back.allocations.map((a) => [a.paymentId, a.targetNumber])).toEqual([
      [advance.id, advance.number],
    ]);
    expect(await ledgerOf(party)).toMatchObject({ balancePaise: -15_000, advancePaise: 15_000 });
    // A refund is not money in: it is never allocated or refunded.
    expect((await owner().post(`/payments/${back.id}/allocate`)).statusCode).toBe(409);
    expect(
      (
        await owner().post(`/payments/${back.id}/refund`, {
          modeId: b.modes.cash.id,
          amountPaise: 1,
        })
      ).statusCode,
    ).toBe(409);
    const [allocation] = back.allocations;
    expect(
      issuesOf(
        await owner().post(`/payments/${advance.id}/allocations/${String(allocation?.id)}/reverse`),
      ),
    ).toEqual(['allocationId']);

    // No voucher was issued for money fully allocated, so its refund has none either.
    const bill = await b.invoice({ partyId: party });
    const full = await paid({ partyId: party, amountPaise: 11_800 });
    ok(
      await owner().post(
        `/payments/${full.id}/allocations/${String(full.allocations[0]?.id)}/reverse`,
      ),
    );
    const plain = ok(
      await owner().post(`/payments/${full.id}/refund`, {
        modeId: b.modes.upi.id,
        amountPaise: 11_800,
        reference: 'UTR-BACK',
      }),
    ).json<PaymentView>();
    expect(plain).toMatchObject({ voucherNumber: null, registerSessionId: null });
    expect(await outstandingOf(party, bill.id)).toBe(11_800);
  });

  it('refunds a cheque only after it clears, and never a bounced one', async () => {
    const party = await customer('Cheque Refund');
    const cheque = await paid({
      partyId: party,
      modeId: b.modes.cheque.id,
      amountPaise: 4_000,
      reference: '123456',
      chequeDate: today,
      allocations: [],
    });
    const refund = () =>
      owner().post(`/payments/${cheque.id}/refund`, { modeId: b.modes.upi.id, amountPaise: 1_000 });
    expect((await refund()).statusCode).toBe(409);
    ok(await owner().post(`/payments/${cheque.id}/bounce`, { reason: 'Stopped' }));
    expect((await refund()).statusCode).toBe(409);
  });
});

describe('reading payments', () => {
  it('lists payments by store, party, mode, direction, cheque status, date and number', async () => {
    const party = await customer('Listed Traders');
    const upi = await paid({ partyId: party, amountPaise: 900, reference: 'UTR-LIST-1' });
    const cheque = await paid({
      partyId: party,
      modeId: b.modes.cheque.id,
      amountPaise: 800,
      reference: 'CHQ-LIST-2',
      chequeDate: today,
    });
    ok(await owner().post(`/payments/${cheque.id}/bounce`, { reason: 'Funds' }));
    const list = async (query: string) =>
      ok(await owner().get(`/payments?partyId=${party}&${query}`)).json<PaymentPage>();
    expect((await list('')).items.map((p) => p.number)).toEqual([cheque.number, upi.number]);
    expect((await list('modeKind=upi')).items.map((p) => p.id)).toEqual([upi.id]);
    expect((await list('chequeStatus=bounced')).items).toMatchObject([
      { id: cheque.id, unallocatedPaise: 0, modeName: 'Cheque' },
    ]);
    expect((await list('direction=out')).total).toBe(0);
    expect((await list(`storeId=${b.stores.amp}&from=${today}&to=${today}`)).total).toBe(2);
    expect((await list('q=list-1')).items.map((p) => p.id)).toEqual([upi.id]);
    expect((await list('limit=1&offset=1')).items.map((p) => p.id)).toEqual([upi.id]);

    const elsewhere = await b.member('branch_manager', [b.stores.kkp]);
    const theirs = ok(
      await api(t, elsewhere).get(`/payments?partyId=${party}`),
    ).json<PaymentPage>();
    expect(theirs.total).toBe(0);
    expect((await api(t, elsewhere).get(`/payments/${upi.id}`)).statusCode).toBe(404);
    expect(ok(await owner().get(`/payments/${upi.id}`)).json<PaymentView>().id).toBe(upi.id);
  });

  it('gives a receipt with the business, the bills settled and the balance', async () => {
    const party = await customer('Receipt Builders');
    const bill = await b.invoice({ partyId: party });
    const payment = await paid({ partyId: party, amountPaise: 20_000 });
    const receipt = ok(await owner().get(`/payments/${payment.id}/receipt`)).json<ReceiptView>();
    expect(receipt).toMatchObject({
      title: 'Receipt voucher',
      number: payment.number,
      voucherNumber: payment.voucherNumber,
      date: today,
      store: {
        code: 'AMP',
        name: 'Ameerpet',
        legalName: 'Rangoli Paints Private Limited',
        gstin: expect.stringMatching(/^36AABCS1429B1Z/),
        address: expect.stringContaining('1-2-3 Main Road'),
      },
      party: { id: party, name: 'Receipt Builders' },
      mode: { kind: 'upi', name: 'UPI' },
      amountPaise: 20_000,
      amountInWords: expect.stringMatching(/Two Hundred/i),
      settled: [{ number: bill.number, amountPaise: 11_800 }],
      unallocatedPaise: 8_200,
      partyBalancePaise: -8_200,
      receivedBy: 'Owner',
    });
    const exact = await paid({ partyId: party, amountPaise: 100, storeId: b.stores.unr });
    expect(ok(await owner().get(`/payments/${exact.id}/receipt`)).json()).toMatchObject({
      title: 'Payment receipt',
      store: { gstin: null },
    });
    const refund = ok(
      await owner().post(`/payments/${payment.id}/refund`, {
        modeId: b.modes.upi.id,
        amountPaise: 200,
      }),
    ).json<PaymentView>();
    expect(ok(await owner().get(`/payments/${refund.id}/receipt`)).json()).toMatchObject({
      title: 'Refund voucher',
      settled: [],
    });
    const plain = ok(
      await owner().post(`/payments/${exact.id}/refund`, {
        modeId: b.modes.upi.id,
        amountPaise: 100,
      }),
    ).json<PaymentView>();
    expect(ok(await owner().get(`/payments/${plain.id}/receipt`)).json()).toMatchObject({
      title: 'Refund',
    });
  });

  it("shows a party's ledger for a period with its opening balance", async () => {
    const party = await customer('Ledger Party');
    await b.invoice({ partyId: party });
    await paid({ partyId: party, amountPaise: 1_000 });
    const all = await ledgerOf(party);
    expect(all.entries).toHaveLength(2);
    const later = await ledgerOf(party, `?from=${await dbToday(t, 1)}`);
    expect(later).toMatchObject({ openingPaise: 10_800, entries: [], closingPaise: 10_800 });
    const earlier = await ledgerOf(party, `?to=${await dbToday(t, -1)}`);
    expect(earlier).toMatchObject({ openingPaise: 0, entries: [], closingPaise: 0 });
    expect(earlier.openDocuments.map((d) => d.outstandingPaise)).toEqual([10_800]);
    const fresh = await customer('Nothing Yet');
    expect(await ledgerOf(fresh)).toMatchObject({ balancePaise: 0, advancePaise: 0, entries: [] });
    expect((await owner().get(`/parties/${crypto.randomUUID()}/ledger`)).statusCode).toBe(404);
  });
});

describe('issuing with payments (the POS)', () => {
  const issueWith = async (body: object, draft: object = {}) => {
    const document = await b.draft({ lines: [{ variantId: b.apex, quantity: 2 }], ...draft });
    return owner().post(`/invoices/${document.id}/issue`, body);
  };

  it('bills a walk-in and takes cash and UPI in one transaction, with change', async () => {
    const issued = ok(
      await issueWith({
        payments: [
          { modeId: b.modes.cash.id, amountPaise: 10_000, tenderedPaise: 10_500 },
          { modeId: b.modes.upi.id, amountPaise: 13_600, reference: 'UTR-POS' },
        ],
      }),
    ).json<IssuedInvoiceView>();
    expect(issued).toMatchObject({
      status: 'issued',
      totalPaise: 23_600,
      paidPaise: 23_600,
      outstandingPaise: 0,
      changePaise: 500,
    });
    expect(issued.payments.map((p) => [p.mode.kind, p.amountPaise, p.registerSessionId])).toEqual([
      ['cash', 10_000, counter.id],
      ['upi', 13_600, null],
    ]);
    expect(issued.payments.every((p) => p.voucherNumber === null)).toBe(true);
    const walkIn = await ledgerOf(String(issued.buyer.partyId));
    expect(walkIn.advancePaise).toBe(0);
    expect(walkIn.openDocuments.some((d) => d.documentId === issued.id)).toBe(false);
  });

  it('wants a walk-in bill paid in full, and never more than is due', async () => {
    const short = await issueWith({ payments: [{ modeId: b.modes.upi.id, amountPaise: 100 }] });
    expect(issuesOf(short)).toEqual(['payments']);
    const over = await issueWith(
      { payments: [{ modeId: b.modes.upi.id, amountPaise: 23_601 }] },
      { partyId: b.parties.homeowner },
    );
    expect(issuesOf(over)).toEqual(['payments']);
    const badMode = await issueWith({
      payments: [{ modeId: b.modes.cheque.id, amountPaise: 23_600 }],
    });
    expect(issuesOf(badMode)).toEqual(['payments.0.reference']);
    // Nothing was issued: the drafts keep no number.
    const drafts = ok(await owner().get('/invoices?status=draft')).json<{ total: number }>();
    expect(drafts.total).toBeGreaterThanOrEqual(3);
  });

  it("uses a customer's advances first, then a part payment, leaving the rest on account", async () => {
    const party = await customer('Advance User');
    await paid({ partyId: party, amountPaise: 5_000, allocations: [] });
    await paid({ partyId: party, amountPaise: 3_000, allocations: [] });
    const key = { 'idempotency-key': `issue-${crypto.randomUUID()}` };
    const document = await b.draft({ partyId: party, lines: [{ variantId: b.apex, quantity: 2 }] });
    const body = {
      allocateAdvances: true,
      payments: [{ modeId: b.modes.card.id, amountPaise: 10_000, reference: 'SLIP-1' }],
    };
    const issued = ok(
      await api(t, b.owner, key).post(`/invoices/${document.id}/issue`, body),
    ).json<IssuedInvoiceView>();
    expect(
      ok(await api(t, b.owner, key).post(`/invoices/${document.id}/issue`, body)).json(),
    ).toEqual(issued);
    expect(issued).toMatchObject({ paidPaise: 18_000, outstandingPaise: 5_600, changePaise: 0 });
    expect(await ledgerOf(party)).toMatchObject({ balancePaise: 5_600, advancePaise: 0 });

    // An advance larger than the bill pays it off and keeps the rest.
    const rich = await customer('Big Advance');
    await paid({ partyId: rich, amountPaise: 30_000, allocations: [] });
    await paid({ partyId: rich, amountPaise: 1_000, allocations: [] });
    const settled = ok(
      await issueWith({ allocateAdvances: true }, { partyId: rich }),
    ).json<IssuedInvoiceView>();
    expect(settled).toMatchObject({ paidPaise: 23_600, outstandingPaise: 0, payments: [] });
    expect(await ledgerOf(rich)).toMatchObject({ balancePaise: -7_400, advancePaise: 7_400 });
    // What is left of the advances pays the next bill, and no more.
    const next = ok(
      await issueWith({ allocateAdvances: true }, { partyId: rich }),
    ).json<IssuedInvoiceView>();
    expect(next).toMatchObject({ paidPaise: 7_400, outstandingPaise: 16_200 });
    expect(await ledgerOf(rich)).toMatchObject({ balancePaise: 16_200, advancePaise: 0 });
  });
});

describe('reconciliation', () => {
  it('keeps every balance equal to invoices − payments ± notes, and allocations in step', async () => {
    expect(await findPartyBalanceMismatches(t.connection.db)).toEqual([]);
    expect(await findAllocationMismatches(t.connection.db)).toEqual([]);
    const balances = await t.connection.db
      .select({ advance: partyBalances.advancePaise })
      .from(partyBalances)
      .where(eq(partyBalances.organizationId, b.organizationId));
    expect(balances.every((row) => row.advance >= 0)).toBe(true);
  });

  it("never shows or touches another business's payments", async () => {
    const other = await billingBusiness(t);
    const party = await customer('Private Party');
    const payment = await paid({ partyId: party, amountPaise: 100, allocations: [] });
    const them = api(t, other.owner);
    expect((await them.get(`/payments/${payment.id}`)).statusCode).toBe(404);
    expect((await them.get(`/payments/${payment.id}/receipt`)).statusCode).toBe(404);
    expect((await them.post(`/payments/${payment.id}/allocate`)).statusCode).toBe(404);
    expect((await them.get(`/parties/${party}/ledger`)).statusCode).toBe(404);
    expect(ok(await them.get('/payments')).json<PaymentPage>().total).toBe(0);
    expect(
      issuesOf(
        await them.post('/payments', {
          storeId: other.stores.amp,
          partyId: party,
          modeId: other.modes.upi.id,
          amountPaise: 100,
        }),
      ),
    ).toEqual(['partyId']);
    expect(
      issuesOf(
        await them.post('/payments', {
          storeId: other.stores.amp,
          partyId: other.parties.contractor,
          modeId: b.modes.upi.id,
          amountPaise: 100,
        }),
      ),
    ).toEqual(['modeId']);
  });
});
