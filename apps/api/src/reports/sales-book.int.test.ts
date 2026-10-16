import { migrateDatabase, postStockMovements, withTenant } from '@paint/db';
import {
  buildTallyExport,
  gstinCheckCharacter,
  parseCsv,
  salesRanges,
  type AuthProfile,
  type IssuedInvoiceView,
  type PaymentLinkCreated,
  type PaymentView,
  type RegisterSessionView,
  type SalesOverview,
  type SalesReturnView,
  type TallyExport,
  type TaxCategoryOptions,
  type TaxDocumentView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AccountingExportsService } from '../accounting/accounting-exports.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import {
  PAYMENT_LINK_GATEWAYS,
  type PaymentLinkGateways,
} from '../payment-links/payment-link-gateways.js';
import { LOG_SIGNATURE_HEADER } from '../payment-links/payment-link-provider.js';
import {
  api,
  billingBusiness,
  dbToday,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { sampleAuth } from '../test-support/sample-auth.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import type { ReportPage, ReportSummary } from './reports.service.js';

/**
 * A small book checked by hand (MVP 3 round 7b, docs/mvp-3/sales-reports.md): invoices at
 * two stores and four rates (18%, 5%, exempt, nil-rated), a composition store's bill of
 * supply, an inter-state B2B invoice with a debit note, a cancelled invoice, a value credit
 * note and a return, and money by cash, UPI, card, a UPI link and a cheque that bounced.
 * Every report's figures are written out below, and the reports must agree with each
 * other, with the dashboard, with the documents, with the Tally export and the day end.
 *
 * Prices include GST: Apex ₹118 a litre (18%), Primer ₹420 a 4 l pack (5%), a shade card
 * ₹50 (exempt), a bag of whiting ₹30 (nil-rated). Days are counted back from today.
 */

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let today: string;
let yesterday: string;
let staff: string;
let staffMemberId: string;
let builders: string;
let dealer: string;
let berger: string;
let primers: string;
let session: string;
let compositionGstin: string;

const PAN = 'AABCS1429B';
const gstin = (state: string, entity: string) => {
  const first14 = `${state}${PAN}${entity}Z`;
  return `${first14}${gstinCheckCharacter(first14)}`;
};
const owner = () => api(t, b.owner);
const report = async (kind: string, query = '', token = b.owner) =>
  ok(
    await api(t, token).get(`/reports/${kind}?limit=500${query ? `&${query}` : ''}`),
  ).json<ReportPage>();
const column = (page: ReportPage, key: string) => page.rows.map((row) => row[key]);
const sum = (page: ReportPage, key: string) =>
  Math.round(page.rows.reduce((total, row) => total + Number(row[key]) * 100, 0));

/** Moves an issued document's date back (only a test can: the trigger is off for it). */
async function backDate(documentId: string, days: number): Promise<void> {
  await t.connection.db.transaction(async (tx) => {
    await tx.execute(sql`alter table tax_documents disable trigger tax_documents_immutable`);
    await tx.execute(
      sql`update tax_documents set issued_on = issued_on - ${days}::integer where id = ${documentId}`,
    );
    await tx.execute(sql`alter table tax_documents enable trigger tax_documents_immutable`);
  });
}

async function sell(
  storeId: string,
  partyId: string,
  lines: { variantId: string; quantity: number }[],
  token = b.owner,
): Promise<IssuedInvoiceView> {
  const draft = await b.draft({ storeId, partyId, lines }, token);
  return ok(await api(t, token).post(`/invoices/${draft.id}/issue`, {})).json<IssuedInvoiceView>();
}

async function product(body: object): Promise<string> {
  const [variant] = ok(await owner().post('/products', body)).json<{ variants: { id: string }[] }>()
    .variants;
  const id = String(variant?.id);
  await withTenant(t.connection.db, b.organizationId, (tx) =>
    postStockMovements(
      tx,
      Object.values(b.stores).map((storeId) => ({
        organizationId: b.organizationId,
        storeId,
        variantId: id,
        movementType: 'opening' as const,
        quantity: 1_000,
      })),
    ),
  );
  return id;
}

const lineOf = (document: TaxDocumentView, index = 0) => String(document.lines[index]?.id);

let primer: string;
let card: string;
let whiting: string;
let invoices: Record<'a' | 'b' | 'c' | 'd' | 'e' | 'i' | 'j', IssuedInvoiceView>;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString, { PAYMENT_LINK_PROVIDER: 'log' });
  b = await billingBusiness(t);
  today = await dbToday(t);
  yesterday = await dbToday(t, -1);
  const o = owner();

  // The godown counter is a composition dealer: it issues bills of supply.
  compositionGstin = gstin('36', '2');
  ok(
    await o.put(`/gst-registrations/stores/${b.stores.unr}`, {
      registrationType: 'composition',
      stateCode: '36',
      gstin: compositionGstin,
      addressLine: '4-5-6 Godown Road',
      city: 'Hyderabad',
      pincode: '500018',
    }),
  );

  // Catalogue: a 5% primer of another brand, an exempt shade card, nil-rated whiting.
  const options = ok(await o.get('/tax-categories/options')).json<TaxCategoryOptions>();
  const exempt = String(options.categories.find((c) => c.key === 'exempt')?.id);
  const fivePercent = ok(
    await o.post('/tax-categories', { name: 'Primers 5%', rateBps: 500 }),
  ).json<{
    id: string;
  }>().id;
  const nil = ok(await o.post('/tax-categories', { name: 'Nil rated', rateBps: 0 })).json<{
    id: string;
  }>().id;
  berger = ok(await o.post('/brands', { name: 'Berger Paints' })).json<{ id: string }>().id;
  const asian = ok(await o.get('/brands'))
    .json<{ id: string; name: string }[]>()
    .find((brand) => brand.name === 'Asian Paints')?.id;
  primers = ok(await o.post('/categories', { name: 'Primers' })).json<{ id: string }>().id;
  const cards = ok(await o.post('/categories', { name: 'Shade cards' })).json<{ id: string }>().id;
  primer = await product({
    brandId: berger,
    categoryId: primers,
    name: 'Primer',
    type: 'primer',
    hsnCode: '32082090',
    taxCategoryId: fivePercent,
    variants: [{ sku: 'PRM-4L', packSize: 4, unit: 'l', sellingPricePaise: 42_000 }],
  });
  card = await product({
    brandId: asian,
    categoryId: cards,
    name: 'Shade card',
    type: 'other',
    hsnCode: '49111010',
    taxCategoryId: exempt,
    variants: [{ sku: 'CRD-1', packSize: 1, unit: 'piece', sellingPricePaise: 5_000 }],
  });
  whiting = await product({
    brandId: berger,
    name: 'Whiting',
    type: 'other',
    hsnCode: '25010010',
    taxCategoryId: nil,
    variants: [{ sku: 'WHT-1KG', packSize: 1, unit: 'kg', sellingPricePaise: 3_000 }],
  });

  // A salesperson at Kukatpally, who looks after the builders.
  staff = await b.member('sales_executive', [b.stores.kkp]);
  staffMemberId = ok(await api(t, staff).get('/auth/me')).json<AuthProfile>().memberId;
  builders = ok(
    await o.post('/parties', {
      displayName: 'Deccan Builders',
      phone: uniquePhone(),
      roles: ['customer'],
      customer: { customerType: 'builder', assignedMemberId: staffMemberId },
    }),
  ).json<{ id: string }>().id;
  dealer = ok(
    await o.post('/parties', {
      displayName: 'Bengaluru Paints',
      phone: uniquePhone(),
      roles: ['customer'],
      gstin: gstin('29', '1'),
      customer: { customerType: 'dealer' },
    }),
  ).json<{ id: string }>().id;

  // The counter at Ameerpet is open for the day.
  session = ok(
    await o.post('/registers/COUNTER-1/open', { storeId: b.stores.amp, openingFloatPaise: 50_000 }),
  ).json<RegisterSessionView>().id;

  const apex = b.apex;
  invoices = {
    // A: today at Ameerpet, 10 l Apex and two primers to the builders.
    a: await sell(b.stores.amp, builders, [
      { variantId: apex, quantity: 10 },
      { variantId: primer, quantity: 2 },
    ]),
    // B: today at Kukatpally, Apex, two shade cards and whiting to Suresh.
    b: await sell(b.stores.kkp, b.parties.homeowner, [
      { variantId: apex, quantity: 5 },
      { variantId: card, quantity: 2 },
      { variantId: whiting, quantity: 1 },
    ]),
    // C: yesterday, inter-state to a registered dealer in Karnataka (IGST).
    c: await sell(b.stores.amp, dealer, [{ variantId: apex, quantity: 20 }]),
    // D: two days ago, a bill of supply at the composition counter.
    d: await sell(b.stores.unr, b.parties.homeowner, [{ variantId: apex, quantity: 3 }]),
    // E: cancelled the same day: never a sale.
    e: await sell(b.stores.amp, b.parties.homeowner, [{ variantId: apex, quantity: 30 }]),
    // I: eight days ago, issued by the salesperson at Kukatpally.
    i: await sell(b.stores.kkp, builders, [{ variantId: apex, quantity: 4 }], staff),
    // J: 35 days ago at Ameerpet.
    j: await sell(b.stores.amp, b.parties.homeowner, [{ variantId: apex, quantity: 1 }]),
  };
  ok(await o.post(`/invoices/${invoices.e.id}/cancel`, { reason: 'Wrong customer' }));

  // F: a value credit note on A (₹118 overcharged); G: one litre of B comes back.
  ok(
    await o.post('/credit-notes', {
      invoiceId: invoices.a.id,
      reason: 'overcharge',
      lines: [{ invoiceLineId: lineOf(invoices.a), valuePaise: 11_800 }],
    }),
  );
  ok(
    await o.post('/sales-returns', {
      invoiceId: invoices.b.id,
      lines: [{ invoiceLineId: lineOf(invoices.b), quantity: 1, disposition: 'restock' }],
    }),
  ).json<SalesReturnView>();
  // H: a debit note on C (₹59 under-charged), dated with it.
  const debit = ok(
    await o.post('/debit-notes', {
      invoiceId: invoices.c.id,
      lines: [{ invoiceLineId: lineOf(invoices.c), valuePaise: 5_900 }],
    }),
  ).json<{ id: string }>();

  // Money: A at the counter by cash and UPI (₹80 too much, refunded in cash); B by card at
  // Kukatpally; C by a cheque yesterday that bounced today; I by a UPI link.
  const pay = async (body: object) =>
    ok(await o.post('/payments', { allocations: [], ...body })).json<PaymentView>();
  await pay({
    storeId: b.stores.amp,
    partyId: builders,
    modeId: b.modes.cash.id,
    amountPaise: 100_000,
    allocations: [{ documentId: invoices.a.id, amountPaise: 100_000 }],
  });
  const upi = await pay({
    storeId: b.stores.amp,
    partyId: builders,
    modeId: b.modes.upi.id,
    amountPaise: 110_000,
    registerSessionId: session,
    allocations: [{ documentId: invoices.a.id, amountPaise: 90_200 }],
  });
  ok(
    await o.post(`/payments/${upi.id}/refund`, {
      modeId: b.modes.cash.id,
      amountPaise: 8_000,
      registerSessionId: session,
    }),
  );
  await pay({
    storeId: b.stores.kkp,
    partyId: b.parties.homeowner,
    modeId: b.modes.card.id,
    amountPaise: 72_000,
    reference: 'SLIP-1',
    allocations: [{ documentId: invoices.b.id, amountPaise: 60_200 }],
  });
  const cheque = await pay({
    storeId: b.stores.amp,
    partyId: dealer,
    modeId: b.modes.cheque.id,
    amountPaise: 236_000,
    reference: '004512',
    chequeDate: yesterday,
    receivedOn: yesterday,
    allocations: [{ documentId: invoices.c.id, amountPaise: 236_000 }],
  });
  ok(await o.post(`/payments/${cheque.id}/bounce`, { reason: 'Funds insufficient' }));
  const link = ok(
    await o.post('/payment-links', {
      partyId: builders,
      purpose: 'invoice',
      invoiceId: invoices.i.id,
    }),
  ).json<PaymentLinkCreated>();
  const gateway = t.app.get<PaymentLinkGateways>(PAYMENT_LINK_GATEWAYS, { strict: false }).log;
  const webhook = gateway?.webhook({
    type: 'payment.captured',
    linkId: String(link.link.url.split('/').at(-1)),
    payment: { amountPaise: link.link.amountPaise },
  });
  ok(
    await t.app.inject({
      method: 'POST',
      url: '/webhooks/payment-links/log',
      headers: {
        'content-type': 'application/json',
        [LOG_SIGNATURE_HEADER]: String(webhook?.signature),
      },
      payload: webhook?.body,
    }),
  );

  // The dates the book says.
  await backDate(invoices.c.id, 1);
  await backDate(debit.id, 1);
  await backDate(invoices.d.id, 2);
  await backDate(invoices.i.id, 8);
  await backDate(invoices.j.id, 35);
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

/** The book by day: net taxable and tax in paise, bills and credit notes. */
const BOOK = [
  { daysAgo: 0, taxable: 2_230_00, tax: 274_00, billsTaxable: 2_430_00, bills: 2, notes: 2 },
  { daysAgo: 1, taxable: 2_050_00, tax: 369_00, billsTaxable: 2_000_00, bills: 1, notes: 0 },
  { daysAgo: 2, taxable: 354_00, tax: 0, billsTaxable: 354_00, bills: 1, notes: 0 },
  { daysAgo: 8, taxable: 400_00, tax: 72_00, billsTaxable: 400_00, bills: 1, notes: 0 },
  { daysAgo: 35, taxable: 100_00, tax: 18_00, billsTaxable: 100_00, bills: 1, notes: 0 },
];
const FROM = () => dbToday(t, -40);

describe('the sales reports, by hand', () => {
  it('total net sales by store: invoices, bills of supply and debit notes less credit notes', async () => {
    const page = await report('sales-by-store');
    expect(page.rows).toEqual([
      {
        store: 'AMP',
        name: 'Ameerpet',
        gstin: gstin('36', '1'),
        bills: 3,
        creditNotes: 1,
        taxable: '3850.00',
        tax: '589.00',
        value: '4439.00',
        averageBill: '1300.00',
        share: 75,
      },
      {
        store: 'KKP',
        name: 'Kukatpally',
        gstin: gstin('36', '1'),
        bills: 2,
        creditNotes: 1,
        taxable: '930.00',
        tax: '144.00',
        value: '1074.00',
        averageBill: '515.00',
        share: 18.1,
      },
      {
        store: 'UNR',
        name: 'Godown counter',
        gstin: compositionGstin,
        bills: 1,
        creditNotes: 0,
        taxable: '354.00',
        tax: '0.00',
        value: '354.00',
        averageBill: '354.00',
        share: 6.9,
      },
    ]);
  });

  it('total by day, week and month, newest first', async () => {
    const days = await report('sales-by-period');
    expect(column(days, 'period')).toEqual(
      await Promise.all(BOOK.map((day) => dbToday(t, -day.daysAgo))),
    );
    expect(column(days, 'taxable')).toEqual(['2230.00', '2050.00', '354.00', '400.00', '100.00']);
    expect(days.rows[0]).toMatchObject({
      bills: 2,
      creditNotes: 2,
      tax: '274.00',
      averageBill: '1215.00',
    });
    for (const interval of ['week', 'month']) {
      const page = await report('sales-by-period', `interval=${interval}`);
      expect(sum(page, 'taxable')).toBe(5_134_00);
      expect(sum(page, 'bills')).toBe(6_00);
    }
    const months = await report('sales-by-period', 'interval=month');
    expect(String(months.rows[0]?.period)).toBe(today.slice(0, 7));
  });

  it('total by pack with net units and litres: a return takes units back, a value note does not', async () => {
    const page = await report('sales-by-product');
    expect(
      page.rows.map((r) => [
        r.sku,
        r.category,
        r.quantity,
        r.litres,
        r.bills,
        r.creditNotes,
        r.taxable,
        r.tax,
      ]),
    ).toEqual([
      ['APX-1L', null, 42, 42, 6, 2, '4204.00', '693.00'],
      ['PRM-4L', 'Primers', 2, 8, 1, 0, '800.00', '40.00'],
      ['CRD-1', 'Shade cards', 2, null, 1, 0, '100.00', '0.00'],
      ['WHT-1KG', null, 1, null, 1, 0, '30.00', '0.00'],
    ]);
    expect(page.rows[1]).toMatchObject({
      brand: 'Berger Paints',
      product: 'Primer',
      variant: '4 l',
    });
  });

  it('total by brand and by category', async () => {
    const brands = await report('sales-by-brand');
    expect(brands.rows).toEqual([
      {
        brand: 'Asian Paints',
        products: 2,
        quantity: 44,
        litres: 42,
        bills: 6,
        creditNotes: 2,
        taxable: '4304.00',
        tax: '693.00',
        value: '4997.00',
        share: 83.8,
      },
      {
        brand: 'Berger Paints',
        products: 2,
        quantity: 3,
        litres: 8,
        bills: 2,
        creditNotes: 0,
        taxable: '830.00',
        tax: '40.00',
        value: '870.00',
        share: 16.2,
      },
    ]);
    const categories = await report('sales-by-category');
    expect(categories.rows.map((r) => [r.category, r.taxable])).toEqual([
      [null, '4234.00'],
      ['Primers', '800.00'],
      ['Shade cards', '100.00'],
    ]);
  });

  it('total by the salesperson who issued each bill, and by customer', async () => {
    const people = await report('sales-by-salesperson');
    expect(people.rows.map((r) => [r.salesperson, r.customers, r.bills, r.taxable])).toEqual([
      ['Owner', 3, 5, '4734.00'],
      ['Staff sales_executive', 1, 1, '400.00'],
    ]);
    const customers = await report('sales-by-customer');
    expect(
      customers.rows.map((r) => [
        r.customer,
        r.customerType,
        r.bills,
        r.creditNotes,
        r.taxable,
        r.tax,
      ]),
    ).toEqual([
      ['Deccan Builders', 'builder', 2, 1, '2100.00', '274.00'],
      ['Bengaluru Paints', 'dealer', 1, 0, '2050.00', '369.00'],
      ['Suresh', 'retail', 3, 1, '984.00', '90.00'],
    ]);
    expect(customers.rows[1]).toMatchObject({ gstin: gstin('29', '1'), lastBilled: yesterday });
  });

  it('filter by dates, kind, B2B, customer type, salespeople, brand, category and product', async () => {
    const net = async (query: string) => sum(await report('sales-by-store', query), 'taxable');
    expect(await net(`from=${today}&to=${today}`)).toBe(2_230_00);
    expect(await net(`to=${await dbToday(t, -3)}`)).toBe(500_00);
    expect(await net('kind=credit_note')).toBe(-200_00);
    expect(await net('kind=bill_of_supply')).toBe(354_00);
    expect(await net('buyerType=b2b')).toBe(2_050_00);
    expect(await net('buyerType=b2c')).toBe(3_084_00);
    expect(await net('customerType=builder')).toBe(2_100_00);
    expect(await net(`salespersonId=${staffMemberId}`)).toBe(400_00);
    expect(await net(`customerSalespersonId=${staffMemberId}`)).toBe(2_100_00);
    expect(await net(`brandId=${berger}`)).toBe(830_00);
    expect(await net(`categoryId=${primers}`)).toBe(800_00);
    expect(await net('product=apex')).toBe(4_204_00);
    expect(await net('product=prm-')).toBe(800_00);
    expect(await net(`storeId=${b.stores.kkp}`)).toBe(930_00);
  });

  it('count collections by day, store and mode, as the day end does', async () => {
    const page = await report('payments-by-mode');
    expect(
      page.rows.map((r) => [
        r.day,
        r.store,
        r.modeKind,
        r.payments,
        r.received,
        r.atCounter,
        r.refunded,
        r.net,
        r.bounced,
      ]),
    ).toEqual([
      [today, 'AMP', 'cash', 2, '1000.00', '1000.00', '80.00', '920.00', '0.00'],
      [today, 'AMP', 'upi', 1, '1100.00', '1100.00', '0.00', '1100.00', '0.00'],
      [today, 'KKP', 'card', 1, '720.00', '0.00', '0.00', '720.00', '0.00'],
      // The link asked for I's ₹472 less the builders' ₹118 advance from credit note F.
      [today, 'KKP', 'upi_link', 1, '354.00', '0.00', '0.00', '354.00', '0.00'],
      [yesterday, 'AMP', 'cheque', 1, '2360.00', '0.00', '0.00', '2360.00', '2360.00'],
    ]);
    expect((await report('payments-by-mode', 'modeKind=cheque')).total).toBe(1);
    expect(
      (await report('payments-by-mode', `from=${today}&to=${today}&storeId=${b.stores.kkp}`)).total,
    ).toBe(2);
    expect((await report('payments-by-mode', `to=${yesterday}`)).total).toBe(1);

    // The counter's day end counts the same money, mode by mode.
    const counter = ok(
      await owner().get(`/register-sessions/${session}`),
    ).json<RegisterSessionView>();
    const atCounter = page.rows.filter((r) => r.day === today && r.store === 'AMP');
    expect(
      counter.modeTotals.map((mode) => [mode.kind, mode.count, mode.inPaise, mode.outPaise]),
    ).toEqual(
      atCounter.map((r) => [
        r.modeKind,
        r.payments,
        Math.round(Number(r.atCounter) * 100),
        Math.round(Number(r.refunded) * 100),
      ]),
    );
  });
});

describe('the GST summary', () => {
  it('nets credit notes by GSTIN, nature, rate, B2B or B2C and supply, exempt and nil apart', async () => {
    const page = await report('gst-summary');
    const ours = gstin('36', '1');
    expect(
      page.rows.map((r) => [
        r.gstin,
        r.section,
        r.rate,
        r.buyerType,
        r.supplyType,
        r.documents,
        r.creditNotes,
        r.taxable,
        r.cgst,
        r.sgst,
        r.igst,
        r.tax,
      ]),
    ).toEqual([
      [ours, 'taxable', 5, 'b2c', 'intra_state', 1, 0, '800.00', '20.00', '20.00', '0.00', '40.00'],
      [
        ours,
        'taxable',
        18,
        'b2b',
        'inter_state',
        2,
        0,
        '2050.00',
        '0.00',
        '0.00',
        '369.00',
        '369.00',
      ],
      [
        ours,
        'taxable',
        18,
        'b2c',
        'intra_state',
        6,
        2,
        '1800.00',
        '162.00',
        '162.00',
        '0.00',
        '324.00',
      ],
      [ours, 'nil_rated', 0, 'b2c', 'intra_state', 1, 0, '30.00', '0.00', '0.00', '0.00', '0.00'],
      [ours, 'exempt', 0, 'b2c', 'intra_state', 1, 0, '100.00', '0.00', '0.00', '0.00', '0.00'],
      [
        compositionGstin,
        'bill_of_supply',
        0,
        'b2c',
        'intra_state',
        1,
        0,
        '354.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
      ],
    ]);
    expect(page.rows[0]).toMatchObject({ stores: 'AMP', cessRate: 0, cess: '0.00' });
    expect(page.rows[2]?.stores).toBe('AMP, KKP');
  });

  it('has an HSN-wise view', async () => {
    const page = await report('gst-hsn-summary');
    expect(
      page.rows.map((r) => [
        r.gstin,
        r.hsn,
        r.section,
        r.rate,
        r.quantity,
        r.taxable,
        r.igst,
        r.value,
      ]),
    ).toEqual([
      [gstin('36', '1'), '25010010', 'nil_rated', 0, 1, '30.00', '0.00', '30.00'],
      [gstin('36', '1'), '32082090', 'taxable', 5, 2, '800.00', '0.00', '840.00'],
      [gstin('36', '1'), '32091090', 'taxable', 18, 39, '3850.00', '369.00', '4543.00'],
      [gstin('36', '1'), '49111010', 'exempt', 0, 2, '100.00', '0.00', '100.00'],
      [compositionGstin, '32091090', 'bill_of_supply', 0, 3, '354.00', '0.00', '354.00'],
    ]);
  });

  it('reconciles exactly with the documents and with the Tally export of the period', async () => {
    const from = await FROM();
    const page = await report('gst-summary', `from=${from}&to=${today}`);
    const heads = ['taxable', 'cgst', 'sgst', 'igst', 'cess'] as const;
    const summary = Object.fromEntries(heads.map((head) => [head, sum(page, head)]));

    // The documents' own totals, issued ones only, credit notes taking away.
    const result = await t.connection.db.execute<Record<(typeof heads)[number], string>>(sql`
      select sum(s * taxable_paise) as taxable, sum(s * cgst_paise) as cgst, sum(s * sgst_paise) as sgst,
        sum(s * igst_paise) as igst, sum(s * cess_paise) as cess
      from (select *, case when kind = 'credit_note' then -1 else 1 end as s from tax_documents) d
      where organization_id = ${b.organizationId} and status = 'issued'
        and kind in ('invoice', 'bill_of_supply', 'debit_note', 'credit_note')`);
    const documents = Object.fromEntries(
      heads.map((head) => [head, Number(result.rows[0]?.[head])]),
    );
    expect(summary).toEqual(documents);
    expect(summary).toEqual({
      taxable: 5_134_00,
      cgst: 182_00,
      sgst: 182_00,
      igst: 369_00,
      cess: 0,
    });

    // The Tally export of the same period: sales ledgers and output tax, credit less debit.
    const exports = t.app.get(AccountingExportsService);
    const auth: AuthContext = {
      ...sampleAuth,
      organization: { id: b.organizationId, name: 'Rangoli' },
      allStores: true,
    };
    const tally: TallyExport = await withTenant(t.connection.db, b.organizationId, async (tx) => {
      const gathered = await exports.gather(tx, auth, {
        from,
        to: today,
        kinds: ['sales', 'credit_note', 'debit_note'],
      });
      return buildTallyExport(gathered.period, gathered.options);
    });
    const purposeOf = new Map(tally.ledgers.map((ledger) => [ledger.name, ledger.purpose]));
    const net = (...purposes: string[]) =>
      tally.vouchers
        .flatMap((voucher) => voucher.entries)
        .filter((entry) => purposes.includes(String(purposeOf.get(entry.ledger))))
        .reduce(
          (total, entry) => total + (entry.side === 'credit' ? entry.paise : -entry.paise),
          0,
        );
    expect({
      taxable: net('sales', 'composition_sales'),
      cgst: net('output_cgst'),
      sgst: net('output_sgst'),
      igst: net('output_igst'),
      cess: net('output_cess'),
    }).toEqual(summary);
    // Rate by rate too: each sales entry carries its rate.
    const tallyByRate = new Map<number, number>();
    for (const entry of tally.vouchers.flatMap((voucher) => voucher.entries)) {
      if (!['sales', 'composition_sales'].includes(String(purposeOf.get(entry.ledger)))) continue;
      const rate = entry.rateBasisPoints ?? 0;
      tallyByRate.set(
        rate,
        (tallyByRate.get(rate) ?? 0) + (entry.side === 'credit' ? entry.paise : -entry.paise),
      );
    }
    const summaryByRate = new Map<number, number>();
    for (const row of page.rows) {
      const rate = Number(row.rate) * 100;
      summaryByRate.set(
        rate,
        (summaryByRate.get(rate) ?? 0) + Math.round(Number(row.taxable) * 100),
      );
    }
    expect(Object.fromEntries(tallyByRate)).toEqual(Object.fromEntries(summaryByRate));
  });

  it('is for members who may export the books, and downloads as CSV', async () => {
    const manager = await b.member('branch_manager', [b.stores.amp]);
    expect((await api(t, manager).get('/reports/gst-summary')).statusCode).toBe(403);
    expect((await api(t, manager).get('/reports/sales-by-store')).statusCode).toBe(200);
    const reply = ok(await owner().get('/reports/gst-summary?format=csv'));
    const [header, first] = parseCsv(reply.body.slice(1));
    expect(header?.slice(0, 3)).toEqual(['Our GSTIN', 'Stores', 'Supply']);
    expect(first?.slice(-6)).toEqual(['800.00', '20.00', '20.00', '0.00', '0.00', '40.00']);
  });
});

describe('the dashboard sales tile', () => {
  const overview = async (query = '', token = b.owner) =>
    ok(await api(t, token).get(`/dashboard/sales${query}`)).json<SalesOverview>();

  it('shows today, this week and this month against the stretch before, and 14 days', async () => {
    const tile = await overview();
    expect(tile.today).toBe(today);
    const days = await Promise.all(
      BOOK.map(async (day) => ({ ...day, day: await dbToday(t, -day.daysAgo) })),
    );
    const within = (range: { from: string; to: string }) =>
      days.filter((d) => d.day >= range.from && d.day <= range.to);
    const expected = salesRanges(today).map(({ key, range, previousRange }) => {
      const taxable = within(range).reduce((s, d) => s + d.taxable, 0);
      const before = within(previousRange).reduce((s, d) => s + d.taxable, 0);
      return { key, taxable, before };
    });
    expect(
      tile.periods.map((p) => ({
        key: p.key,
        taxable: p.figures.taxablePaise,
        before: p.previous.taxablePaise,
      })),
    ).toEqual(expected);
    expect(tile.periods[0]).toMatchObject({
      figures: {
        taxablePaise: 2_230_00,
        taxPaise: 274_00,
        valuePaise: 2_504_00,
        bills: 2,
        creditNotes: 2,
        averageBillPaise: 1_215_00,
      },
      previous: { taxablePaise: 2_050_00, bills: 1 },
      changeBps: 878,
    });
    expect(tile.days).toHaveLength(14);
    expect(tile.days.at(-1)).toEqual({ day: today, taxablePaise: 2_230_00, bills: 2 });
    expect(tile.days.find((d) => d.day === yesterday)?.taxablePaise).toBe(2_050_00);
  });

  it('agrees with the reports: Σ by store = Σ by day = Σ by product = the month', async () => {
    const tile = await overview();
    const month = tile.periods[2];
    const range = `from=${String(month?.range.from)}&to=${today}`;
    const byStore = sum(await report('sales-by-store', range), 'taxable');
    expect(sum(await report('sales-by-period', range), 'taxable')).toBe(byStore);
    expect(sum(await report('sales-by-product', range), 'taxable')).toBe(byStore);
    expect(sum(await report('sales-by-brand', range), 'taxable')).toBe(byStore);
    expect(sum(await report('sales-by-customer', range), 'taxable')).toBe(byStore);
    expect(sum(await report('sales-by-salesperson', range), 'taxable')).toBe(byStore);
    expect(month?.figures.taxablePaise).toBe(byStore);
    expect(sum(await report('sales-by-store', range), 'tax')).toBe(month?.figures.taxPaise);
  });

  it('keeps to one store, and to the member’s stores', async () => {
    expect((await overview(`?storeId=${b.stores.kkp}`)).periods[0]?.figures.taxablePaise).toBe(
      530_00,
    );
    const theirs = await overview('', staff);
    expect(theirs.periods[0]?.figures.taxablePaise).toBe(530_00);
    expect((await api(t, staff).get(`/dashboard/sales?storeId=${b.stores.amp}`)).statusCode).toBe(
      404,
    );
    expect(sum(await report('sales-by-store', '', staff), 'taxable')).toBe(930_00);
    const stock = await b.member('inventory_manager', [b.stores.amp]);
    expect((await api(t, stock).get('/dashboard/sales')).statusCode).toBe(403);
    expect((await api(t, stock).get('/reports/sales-by-product')).statusCode).toBe(403);
  });
});

describe('the report list', () => {
  it('offers the sales reports with their filters, and the GST summary to owners', async () => {
    const list = ok(await owner().get('/reports')).json<ReportSummary[]>();
    const byPeriod = list.find((r) => r.kind === 'sales-by-period');
    expect(byPeriod?.filters.map((f) => [f.name, f.type])).toEqual([
      ['interval', 'enum'],
      ['storeId', 'store'],
      ['from', 'date'],
      ['to', 'date'],
      ['kind', 'enum'],
      ['buyerType', 'enum'],
      ['customerType', 'enum'],
      ['salespersonId', 'member'],
      ['customerSalespersonId', 'member'],
      ['brandId', 'brand'],
      ['categoryId', 'category'],
      ['product', 'text'],
    ]);
    expect(list.map((r) => r.kind)).toEqual(
      expect.arrayContaining(['gst-summary', 'gst-hsn-summary']),
    );
    const reply = ok(await owner().get('/reports/sales-by-store?format=csv'));
    const [header] = parseCsv(reply.body.slice(1));
    expect(header).toContain('Net sales (₹, before GST)');
  });
});
