import { migrateDatabase, schema, withTenant } from '@paint/db';
import {
  AGEING_BUCKETS,
  type AgeingPage,
  type AgeingRowView,
  type AuthProfile,
  type IssuedInvoiceView,
  type NoteView,
  type PaymentView,
  type ReceivablesSummaryView,
  type StatementData,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  dbToday,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

const { creditProfiles, partyBalances, partyLedger } = schema;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let today: string;
/** Days from today, as the database counts them. */
const day = (offset: number) => dbToday(t, offset);
let salesperson: { token: string; memberId: string };
let krishna: string;
let suresh: string;
let ramesh: string;
const bills = {} as Record<'a1' | 'a2' | 'a3' | 'a4' | 'a5' | 'b1', IssuedInvoiceView>;
let creditNote: NoteView;

const owner = () => api(t, b.owner);
const get = async <T>(url: string, token = b.owner) => ok(await api(t, token).get(url)).json<T>();

async function customer(body: object): Promise<string> {
  return ok(await owner().post('/parties', { phone: uniquePhone(), ...body })).json<{
    id: string;
  }>().id;
}

async function bill(
  partyId: string,
  quantity: number,
  dueOn: string,
  storeId = b.stores.amp,
  issue: object = {},
) {
  const draft = await b.draft({
    storeId,
    partyId,
    dueOn,
    lines: [{ variantId: b.apex, quantity }],
  });
  return ok(await owner().post(`/invoices/${draft.id}/issue`, issue)).json<IssuedInvoiceView>();
}

async function pay(body: object): Promise<PaymentView> {
  return ok(
    await owner().post('/payments', { storeId: b.stores.amp, ...body }),
  ).json<PaymentView>();
}

/**
 * A business with real books: credit invoices of every age, a partial payment, a
 * bounced cheque with a charge, a credit note, a paid counter bill, an advance with a
 * refund out of it, and an opening balance with a part payment.
 */
beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  today = await dbToday(t);
  const token = await b.member('sales_executive', [b.stores.amp]);
  salesperson = { token, memberId: (await get<AuthProfile>('/auth/me', token)).memberId };

  krishna = await customer({
    displayName: 'Krishna Constructions',
    roles: ['customer', 'contractor'],
    customer: { assignedMemberId: salesperson.memberId },
  });
  suresh = await customer({
    displayName: 'Suresh Homes',
    roles: ['customer'],
    homeStoreId: b.stores.amp,
    addressLine: 'Plot 4, Ameerpet',
    city: 'Hyderabad',
  });
  ramesh = await customer({ displayName: 'Ramesh Painter', roles: ['customer', 'painter'] });
  await t.connection.db.insert(creditProfiles).values({
    organizationId: b.organizationId,
    partyId: krishna,
    status: 'active',
    limitPaise: 500_000,
    creditDays: 30,
  });

  // Go-live 40 days ago: Ramesh owed ₹2,000, overdue since 70 days ago.
  ok(
    await owner().post('/sales/go-live', {
      liveOn: await day(-40),
      openings: [{ partyId: ramesh, amountPaise: 200_000, overdueSince: await day(-70) }],
    }),
  );

  bills.a1 = await bill(krishna, 5, await day(-45)); // ₹590, 45 days late
  bills.a2 = await bill(krishna, 10, await day(10), b.stores.kkp); // ₹1,180, not yet due
  bills.a3 = await bill(krishna, 2, await day(-95)); // ₹236, 95 days late
  bills.a4 = await bill(krishna, 1, await day(3)); // ₹118, due this week
  bills.a5 = await bill(krishna, 1, today); // ₹118, due today
  bills.b1 = await bill(suresh, 1, today, b.stores.amp, {
    payments: [{ modeId: b.modes.upi.id, amountPaise: 11_800 }],
  });

  // A part payment on A1, two days ago.
  await pay({
    partyId: krishna,
    modeId: b.modes.upi.id,
    amountPaise: 30_000,
    receivedOn: await day(-2),
    allocations: [{ documentId: bills.a1.id, amountPaise: 30_000 }],
  });
  // A cheque three days ago, A3 paid and the rest an advance; it bounced yesterday.
  const cheque = await pay({
    partyId: krishna,
    modeId: b.modes.cheque.id,
    amountPaise: 40_000,
    reference: '445566',
    chequeDate: await day(-3),
    receivedOn: await day(-3),
    allocations: [{ documentId: bills.a3.id, amountPaise: 23_600 }],
  });
  ok(
    await owner().post(`/payments/${cheque.id}/bounce`, {
      reason: 'Insufficient funds',
      bouncedOn: await day(-1),
      chargePaise: 5_000,
    }),
  );
  // A credit note for an overcharge on A2: settled against it.
  creditNote = ok(
    await owner().post('/credit-notes', {
      invoiceId: bills.a2.id,
      reason: 'overcharge',
      lines: [{ invoiceLineId: String(bills.a2.lines[0]?.id), valuePaise: 11_800 }],
    }),
  ).json<NoteView>();
  // Suresh pays ₹500 ahead and gets ₹200 back.
  const advance = await pay({ partyId: suresh, modeId: b.modes.bank.id, amountPaise: 50_000 });
  ok(
    await owner().post(`/payments/${advance.id}/refund`, {
      modeId: b.modes.bank.id,
      amountPaise: 20_000,
    }),
  );
  // Ramesh pays ₹500 five days ago: the opening balance takes it.
  await pay({
    partyId: ramesh,
    modeId: b.modes.upi.id,
    amountPaise: 50_000,
    receivedOn: await day(-5),
  });
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

const ageing = (query = '', token = b.owner) =>
  get<AgeingPage>(`/receivables/ageing${query}`, token);
const rowOf = (page: AgeingPage, id: string | null) => page.rows.find((row) => row.id === id);
const sumBuckets = (row: AgeingRowView) =>
  AGEING_BUCKETS.reduce((sum, bucket) => sum + row.totals.buckets[bucket], 0);

/** Σ party_ledger up to and including `asOf`, per party. */
async function ledgerBalances(asOf: string): Promise<Map<string, number>> {
  const rows = await withTenant(t.connection.db, b.organizationId, (tx) =>
    tx
      .select({
        partyId: partyLedger.partyId,
        total: sql<string>`sum(${partyLedger.amountPaise})`,
      })
      .from(partyLedger)
      .where(sql`${partyLedger.entryOn} <= ${asOf}::date`)
      .groupBy(partyLedger.partyId),
  );
  return new Map(rows.map((row) => [row.partyId, Number(row.total)]));
}

describe('ageing matches the party ledger exactly (done when, P2-M10)', () => {
  it('Σ buckets = party_balances balance + advance, and the advance is what is unapplied, for every party', async () => {
    const page = await ageing('?limit=500');
    const balances = await withTenant(t.connection.db, b.organizationId, (tx) =>
      tx.select().from(partyBalances),
    );
    expect(balances).toHaveLength(3);
    for (const balance of balances) {
      const row = rowOf(page, balance.partyId);
      const buckets = row === undefined ? 0 : sumBuckets(row);
      const unapplied = row?.totals.unappliedPaise ?? 0;
      expect({ party: balance.partyId, buckets, unapplied }).toEqual({
        party: balance.partyId,
        buckets: balance.balancePaise + balance.advancePaise,
        unapplied: balance.advancePaise,
      });
      expect(row?.totals.netPaise ?? 0).toBe(balance.balancePaise);
    }
    // Every row is a party with a balance; the page's totals are the rows'.
    expect(page.rows.every((row) => balances.some((bal) => bal.partyId === row.id))).toBe(true);
    expect(page.totals.netPaise).toBe(balances.reduce((sum, bal) => sum + bal.balancePaise, 0));
  });

  it('matches the ledger summed to any earlier day too', async () => {
    for (const offset of [-41, -40, -6, -5, -4, -3, -2, -1, 0, 30]) {
      const asOf = await day(offset);
      const page = await ageing(`?asOf=${asOf}&limit=500`);
      const ledger = await ledgerBalances(asOf);
      const nets = new Map(page.rows.map((row) => [row.id, row.totals.netPaise]));
      for (const [partyId, total] of ledger) {
        expect({ asOf, partyId, net: nets.get(partyId) ?? 0 }).toEqual({
          asOf,
          partyId,
          net: total,
        });
      }
      expect(page.rows.every((row) => ledger.has(String(row.id)))).toBe(true);
    }
  });

  it('ages each customer by bucket, with the bounce, the credit note, the advance and the opening', async () => {
    const page = await ageing();
    const noteLeft = bills.a2.totalPaise - creditNote.totalPaise;
    expect(rowOf(page, krishna)).toEqual({
      id: krishna,
      name: 'Krishna Constructions',
      code: null,
      phone: expect.any(String),
      limitPaise: 500_000,
      customers: 1,
      maxDaysPastDue: 95,
      totals: {
        buckets: {
          not_due: noteLeft + 11_800,
          days_0_30: 11_800 + 5_000, // due today, and the bounce charge (1 day)
          days_31_60: 59_000 - 30_000,
          days_61_90: 0,
          days_90_plus: 23_600, // reopened by the bounce
        },
        outstandingPaise: noteLeft + 11_800 + 16_800 + 29_000 + 23_600,
        unappliedPaise: 0,
        netPaise: noteLeft + 11_800 + 16_800 + 29_000 + 23_600,
      },
    });
    expect(rowOf(page, suresh)).toMatchObject({
      name: 'Suresh Homes',
      limitPaise: null,
      maxDaysPastDue: null,
      totals: { outstandingPaise: 0, unappliedPaise: 30_000, netPaise: -30_000 },
    });
    expect(rowOf(page, ramesh)).toMatchObject({
      maxDaysPastDue: 70,
      totals: { buckets: { days_61_90: 150_000 }, netPaise: 150_000 },
    });
    // Largest balance first.
    expect(page.rows.map((row) => row.id)).toEqual([krishna, ramesh, suresh]);
    expect(page).toMatchObject({ asOf: today, groupBy: 'customer', total: 3 });
  });

  it('groups by salesperson and by store, adding up to the same totals', async () => {
    const all = await ageing();
    const people = await ageing('?groupBy=salesperson');
    expect(people.rows.map((row) => [row.id, row.name, row.customers])).toEqual([
      [salesperson.memberId, 'Staff sales_executive', 1],
      [null, null, 2],
    ]);
    expect(people.totals).toEqual(all.totals);
    const stores = await ageing('?groupBy=store');
    expect(stores.totals).toEqual(all.totals);
    expect(rowOf(stores, null)).toMatchObject({ name: null, totals: { netPaise: 150_000 } });
    expect(rowOf(stores, b.stores.kkp)).toMatchObject({
      name: 'Kukatpally',
      code: 'KKP',
      customers: 1,
      totals: { buckets: { not_due: bills.a2.totalPaise - creditNote.totalPaise } },
    });
    expect(rowOf(stores, b.stores.amp)).toMatchObject({ code: 'AMP', customers: 2 });
  });

  it('filters by store, salesperson, search and lateness, and pages', async () => {
    const kkp = await ageing(`?storeId=${b.stores.kkp}`);
    expect(kkp.rows.map((row) => row.id)).toEqual([krishna]);
    expect((await ageing(`?salespersonId=${salesperson.memberId}`)).rows.map((r) => r.id)).toEqual([
      krishna,
    ]);
    expect((await ageing('?salespersonId=none')).rows.map((r) => r.id)).toEqual([ramesh, suresh]);
    expect((await ageing('?q=krish')).rows.map((r) => r.id)).toEqual([krishna]);
    const phone = String(rowOf(await ageing(), suresh)?.phone);
    expect((await ageing(`?q=${phone.slice(-6)}`)).rows.map((r) => r.id)).toEqual([suresh]);
    expect((await ageing('?overdueOnly=true')).rows.map((r) => r.id)).toEqual([krishna, ramesh]);
    const second = await ageing('?limit=1&offset=1');
    expect(second.rows.map((r) => r.id)).toEqual([ramesh]);
    expect(second).toMatchObject({ total: 3, totals: (await ageing()).totals });
    // Before Ramesh's opening, nobody owed anything.
    expect((await ageing(`?asOf=${await day(-41)}`)).rows).toEqual([]);
  });

  it('refuses bad filters and other stores, and hides what a member may not see', async () => {
    expect((await owner().get('/receivables/ageing?groupBy=brand')).statusCode).toBe(400);
    expect((await owner().get('/receivables/ageing?asOf=yesterday')).statusCode).toBe(400);
    expect((await owner().get('/receivables/summary?salespersonId=x')).statusCode).toBe(400);
    const employee = await b.member('store_employee', [b.stores.amp]);
    expect((await api(t, employee).get('/receivables/summary')).statusCode).toBe(403);
    expect((await api(t, employee).get('/receivables/ageing')).statusCode).toBe(403);
    const manager = await b.member('branch_manager', [b.stores.kkp]);
    // Suresh's home store is Ameerpet: not this manager's customer.
    expect((await ageing('', manager)).rows.map((r) => r.id)).toEqual([krishna, ramesh]);
    expect(
      (await api(t, manager).get(`/receivables/ageing?storeId=${b.stores.amp}`)).statusCode,
    ).toBe(404);
    expect((await ageing(`?storeId=${b.stores.kkp}`, manager)).rows.map((r) => r.id)).toEqual([
      krishna,
    ]);
  });
});

describe('GET /receivables/summary', () => {
  it('gives the dashboard figures: due today, this week, overdue, credit used and who owes most', async () => {
    const summary = await get<ReceivablesSummaryView>('/receivables/summary');
    const all = await ageing();
    const krishnaNet = Number(rowOf(all, krishna)?.totals.netPaise);
    expect(summary).toEqual({
      asOf: today,
      totals: all.totals,
      dueTodayPaise: 11_800,
      dueThisWeekPaise: 11_800 + 11_800,
      overduePaise: 29_000 + 23_600 + 5_000 + 150_000,
      customers: 2,
      credit: {
        limitPaise: 500_000,
        usedPaise: krishnaNet,
        utilisationBps: Math.round((krishnaNet * 10_000) / 500_000),
        overLimit: 0,
      },
      topCustomers: [
        {
          partyId: krishna,
          name: 'Krishna Constructions',
          phone: expect.any(String),
          netPaise: krishnaNet,
          overduePaise: 29_000 + 23_600 + 5_000,
          maxDaysPastDue: 95,
        },
        {
          partyId: ramesh,
          name: 'Ramesh Painter',
          phone: expect.any(String),
          netPaise: 150_000,
          overduePaise: 150_000,
          maxDaysPastDue: 70,
        },
      ],
    });
  });

  it('narrows to a salesperson, keeping every credit customer of theirs in the limit', async () => {
    const theirs = await get<ReceivablesSummaryView>(
      `/receivables/summary?salespersonId=${salesperson.memberId}`,
    );
    expect(theirs.topCustomers.map((c) => c.partyId)).toEqual([krishna]);
    expect(theirs.credit.limitPaise).toBe(500_000);
    const nobody = await get<ReceivablesSummaryView>('/receivables/summary?salespersonId=none');
    expect(nobody.credit).toEqual({
      limitPaise: 0,
      usedPaise: 0,
      utilisationBps: null,
      overLimit: 0,
    });
    const later = await get<ReceivablesSummaryView>(`/receivables/summary?asOf=${await day(20)}`);
    expect(later.dueThisWeekPaise).toBe(0);
    const manager = await b.member('branch_manager', [b.stores.kkp]);
    const scoped = await get<ReceivablesSummaryView>('/receivables/summary', manager);
    expect(scoped.customers).toBe(2);
    expect(scoped.credit.limitPaise).toBe(500_000);
  });
});

describe('receivables reports (CSV)', () => {
  it('lists the ageing reports for those who see credit', async () => {
    const kinds = (await get<{ kind: string }[]>('/reports')).map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['receivables-ageing', 'receivables-open-bills']));
    const employee = await b.member('store_employee', [b.stores.amp]);
    const theirs = (await get<{ kind: string }[]>('/reports', employee)).map((r) => r.kind);
    expect(theirs).not.toContain('receivables-ageing');
    expect((await api(t, employee).get('/reports/receivables-ageing')).statusCode).toBe(403);
  });

  it('pages the ageing by store and exports every row as CSV', async () => {
    const page = await get<{ rows: Record<string, unknown>[]; total: number }>(
      '/reports/receivables-ageing?groupBy=store&limit=1',
    );
    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(1);
    const csv = await owner().get(`/reports/receivables-ageing?format=csv&asOf=${today}`);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.body.split('\r\n').filter((line) => line !== '');
    expect(lines[0]).toContain('Name,Store code,Mobile,Customers,Not yet due (₹)');
    expect(lines).toHaveLength(4);
    expect(csv.body).toContain('Ramesh Painter,,');
    expect(csv.body).toContain(',1500.00,0.00,1500.00,70,');
    expect((await owner().get('/reports/receivables-ageing?groupBy=x')).statusCode).toBe(400);
  });

  it('lists every open bill, most overdue first', async () => {
    const page = await get<{ rows: Record<string, unknown>[] }>(
      `/reports/receivables-open-bills?storeId=${b.stores.amp}`,
    );
    expect(page.rows[0]).toMatchObject({
      customer: 'Krishna Constructions',
      salesperson: 'Staff sales_executive',
      store: 'AMP',
      kind: 'invoice',
      number: bills.a3.number,
      daysPastDue: 95,
      bucket: 'days_90_plus',
      total: '236.00',
      outstanding: '236.00',
    });
    expect(page.rows.map((r) => r.kind)).toContain('charge');
    expect(page.rows.at(-1)).toMatchObject({ daysPastDue: 0, bucket: 'not_due' });
    const all = await get<{ rows: Record<string, unknown>[] }>('/reports/receivables-open-bills');
    expect(all.rows.find((r) => r.kind === 'opening')).toMatchObject({
      customer: 'Ramesh Painter',
      salesperson: null,
      store: null,
      number: null,
      outstanding: '1500.00',
    });
  });
});

describe('GET /parties/:id/statement (P2-M12)', () => {
  const statement = async (partyId: string, from: string, to: string, token = b.owner) =>
    get<StatementData>(`/parties/${partyId}/statement?from=${from}&to=${to}`, token);

  it('gives the opening balance, every entry, the closing balance and the ageing that matches it', async () => {
    const from = await day(-60);
    const data = await statement(krishna, from, today);
    const [balance] = await t.connection.db
      .select()
      .from(partyBalances)
      .where(eq(partyBalances.partyId, krishna));
    expect(data).toMatchObject({
      business: { name: expect.stringContaining('Rangoli Paints'), gstin: null, address: null },
      party: { id: krishna, name: 'Krishna Constructions', gstin: null, address: null },
      from,
      to: today,
      generatedOn: today,
      openingPaise: 0,
      closingPaise: balance?.balancePaise,
    });
    expect(data.entries.map((e) => e.entryType)).toEqual([
      'payment_in', // the cheque, three days ago
      'payment_in', // two days ago
      'cheque_bounce', // yesterday
      'adjustment',
      'invoice',
      'invoice',
      'invoice',
      'invoice',
      'invoice',
      'credit_note',
    ]);
    expect(data.entries[0]).toMatchObject({
      entryOn: await day(-3),
      referenceNumber: expect.stringMatching(/^RC-/),
      amountPaise: -40_000,
      balancePaise: -40_000,
    });
    expect(data.entries.at(-1)?.balancePaise).toBe(data.closingPaise);
    expect(data.debitsPaise - data.creditsPaise).toBe(data.closingPaise - data.openingPaise);
    expect(data.ageing.netPaise).toBe(data.closingPaise);
    expect(data.openItems[0]).toMatchObject({
      kind: 'invoice',
      number: bills.a3.number,
      daysPastDue: 95,
      outstandingPaise: 23_600,
    });
  });

  it('ends on an earlier day with the ageing of that day, and opens with what came before', async () => {
    const data = await statement(krishna, await day(-3), await day(-1));
    expect(data.openingPaise).toBe(0);
    // The cheque came back with a ₹50 charge; the UPI part payment stays, unallocated until
    // today's invoices, so on that day it is money paid ahead.
    expect(data.closingPaise).toBe(-25_000);
    expect(data.ageing).toMatchObject({ outstandingPaise: 5_000, unappliedPaise: 30_000 });
    expect(data.ageing.netPaise).toBe(data.closingPaise);
    const later = await statement(krishna, today, today);
    expect(later.openingPaise).toBe(-25_000);
    const opening = await statement(ramesh, await day(-30), today);
    expect(opening).toMatchObject({ openingPaise: 200_000, closingPaise: 150_000 });
    expect(opening.openItems).toEqual([
      {
        kind: 'opening',
        number: null,
        raisedOn: await day(-40),
        dueOn: await day(-70),
        outstandingPaise: 150_000,
        daysPastDue: 70,
      },
    ]);
  });

  it('prints the letterhead of the customer’s home store when it is registered', async () => {
    const data = await statement(suresh, today, today);
    expect(data.business).toMatchObject({
      legalName: 'Rangoli Paints Private Limited',
      gstin: expect.stringMatching(/^36/),
      address: expect.stringContaining('1-2-3 Main Road, Hyderabad'),
    });
    expect(data.party.address).toBe('Plot 4, Ameerpet, Hyderabad');
    expect(data.ageing).toMatchObject({ unappliedPaise: 30_000, netPaise: -30_000 });
    expect(data.closingPaise).toBe(-30_000);
  });

  it('refuses a backwards period, an unknown party, one the member cannot see, and no permission', async () => {
    const bad = await owner().get(
      `/parties/${krishna}/statement?from=${today}&to=${await day(-1)}`,
    );
    expect(bad.statusCode).toBe(400);
    expect((await owner().get(`/parties/${krishna}/statement?from=${today}`)).statusCode).toBe(400);
    const nobody = await owner().get(
      `/parties/${crypto.randomUUID()}/statement?from=${today}&to=${today}`,
    );
    expect(nobody.statusCode).toBe(404);
    const manager = await b.member('branch_manager', [b.stores.kkp]);
    const hidden = await api(t, manager).get(
      `/parties/${suresh}/statement?from=${today}&to=${today}`,
    );
    expect(hidden.statusCode).toBe(404);
    // Counter staff see the ledger, so they may print the statement.
    const employee = await b.member('store_employee', [b.stores.amp]);
    expect((await statement(krishna, today, today, employee)).party.id).toBe(krishna);
    const inventory = await b.member('inventory_manager', [b.stores.amp]);
    const refused = await api(t, inventory).get(
      `/parties/${krishna}/statement?from=${today}&to=${today}`,
    );
    expect(refused.statusCode).toBe(403);
  });

  it('downloads the statement as a PDF, in English or with Telugu labels', async () => {
    const from = await day(-60);
    const reply = await owner().get(
      `/parties/${krishna}/statement.pdf?from=${from}&to=${today}&lang=te`,
    );
    expect(reply.statusCode).toBe(200);
    expect(reply.headers['content-type']).toBe('application/pdf');
    expect(reply.headers['content-disposition']).toContain(
      `Statement-Krishna-Constructions-${from}-${today}.pdf`,
    );
    expect(reply.headers['cache-control']).toBe('private, no-store');
    const document = await getDocumentProxy(new Uint8Array(reply.rawPayload));
    const text = (await extractText(document)).text.join(' ').replace(/\s+/g, ' ');
    expect(text).toContain('Statement of Account');
    expect(text).toContain('Krishna Constructions');
    expect(text).toContain('Credit జమ');
    const english = await owner().get(`/parties/${krishna}/statement.pdf?from=${from}&to=${today}`);
    expect(english.statusCode).toBe(200);
    const bad = await owner().get(
      `/parties/${krishna}/statement.pdf?from=${from}&to=${today}&lang=fr`,
    );
    expect(bad.statusCode).toBe(400);
  });

  it('refuses a period with more entries than one statement prints', async () => {
    const busy = await customer({ displayName: 'Busy Builders', roles: ['customer'] });
    // 5,001 small charges in one go (postPartyLedger writes them one at a time).
    await withTenant(t.connection.db, b.organizationId, async (tx) => {
      await tx.insert(partyLedger).values(
        Array.from({ length: 5_001 }, () => ({
          organizationId: b.organizationId,
          partyId: busy,
          entryOn: today,
          entryType: 'adjustment' as const,
          amountPaise: 1,
        })),
      );
      await tx
        .insert(partyBalances)
        .values({ organizationId: b.organizationId, partyId: busy, balancePaise: 5_001 });
    });
    const reply = await owner().get(`/parties/${busy}/statement?from=${today}&to=${today}`);
    expect(reply.statusCode).toBe(422);
    expect(reply.json<{ issues: { path: string }[] }>().issues[0]?.path).toBe('from');
  });
});
