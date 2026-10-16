import { migrateDatabase, postStockMovements, schema, withTenant } from '@paint/db';
import {
  gstinCheckCharacter,
  parseCsv,
  previousQuarter,
  sumMargins,
  type BrandProfitabilityView,
  type IssuedInvoiceView,
  type MarginFigures,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import {
  api,
  billingBusiness,
  dbToday,
  issuesOf,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import { finishSignIn } from '../test-support/two-factor.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { ReportSummary } from '../reports/reports.service.js';
import { brandProfitability } from './brand-profitability.js';
import { brandProfitabilitySchema } from './brand-profitability.schemas.js';
import { NO_SCHEME_MONEY, type SchemeMoneySource } from './scheme-money.js';

const { creditProfiles } = schema;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let asian: string;
let nerolac: string;
let berger: string;
let indigo: string;
let apex: string;
let beauty: string;
let beautyVariant: string;
let from: string;
let to: string;

const owner = () => api(t, b.owner);
const view = async (query: string, token = b.owner) =>
  ok(
    await api(t, token).get(`/reports/brand-profitability?from=${from}&to=${to}&${query}`),
  ).json<BrandProfitabilityView>();

async function party(displayName: string, roles: string[], enrol: boolean): Promise<string> {
  const id = ok(await owner().post('/parties', { displayName, phone: uniquePhone(), roles })).json<{
    id: string;
  }>().id;
  if (enrol) ok(await owner().post(`/parties/${id}/loyalty`, {}));
  return id;
}

async function sale(
  storeId: string,
  partyId: string,
  lines: { variantId: string; quantity: number }[],
  extra: { influencerPartyId?: string; issue?: object } = {},
): Promise<IssuedInvoiceView> {
  const draft = await b.draft({
    storeId,
    partyId,
    lines,
    ...(extra.influencerPartyId ? { influencerPartyId: extra.influencerPartyId } : {}),
  });
  return ok(
    await owner().post(`/invoices/${draft.id}/issue`, extra.issue ?? {}),
  ).json<IssuedInvoiceView>();
}

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

async function pay(storeId: string, partyId: string, invoice: IssuedInvoiceView, on: string) {
  ok(
    await owner().post('/payments', {
      storeId,
      partyId,
      modeId: b.modes.upi.id,
      amountPaise: invoice.totalPaise,
      reference: `UPI-${invoice.id.slice(0, 8)}`,
      receivedOn: on,
      allocations: [{ documentId: invoice.id, amountPaise: invoice.totalPaise }],
    }),
  );
}

async function costedReceipt(storeId: string, variantId: string, quantity: number, cost: number) {
  await withTenant(t.connection.db, b.organizationId, (tx) =>
    postStockMovements(tx, [
      {
        organizationId: b.organizationId,
        storeId,
        variantId,
        movementType: 'purchase_receipt',
        quantity,
        unitCostPaise: cost,
      },
    ]),
  );
}

/** A member whose only permission is the books', at Kukatpally only. */
async function accountsMember(): Promise<string> {
  const role = ok(
    await owner().post('/roles', { name: 'Accounts', permissions: ['accounting:export'] }),
  ).json<{ id: string }>();
  const phone = uniquePhone();
  ok(
    await owner().post('/members', {
      fullName: 'Accounts clerk',
      phone,
      password: 'Staff@2026',
      roleId: role.id,
      storeIds: [b.stores.kkp],
    }),
  );
  const login = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier: phone, password: 'Staff@2026' },
  });
  return (await finishSignIn<{ token: string }>(t, login, phone)).token;
}

/** The figures with their components, as the engine computes them. */
const figures = (over: Partial<MarginFigures>): MarginFigures => ({
  invoicedPaise: 0,
  creditNotePaise: 0,
  netSalesPaise: 0,
  costPaise: 0,
  grossMarginPaise: 0,
  schemeReceivedPaise: 0,
  schemeExpectedPaise: 0,
  creditCostPaise: 0,
  loyaltyPaise: 0,
  painterPointsPaise: 0,
  contributionPaise: 0,
  marginBps: null,
  ...over,
});

/*
 * The books, by hand (D = today; the period is D−59 to D; GST 18 %):
 *
 * - Apex (Asian Paints) ₹100 a litre taxable; a costed receipt sets its average cost
 *   at ₹60 at Ameerpet and ₹65 at Kukatpally (the opening stock had no cost; at the
 *   unregistered counter it still has none). Beauty (Nerolac) ₹200 taxable, ₹150 cost.
 * - A, D−40, Ameerpet: the contractor, 10 l Apex (₹1,000 + GST = ₹1,180) brought in by
 *   the painter; paid D−20, so ₹1,180 owed for 20 days = 2,360,000 paise-days.
 * - B, D−10, Ameerpet: the homeowner, 3 l Apex and 2 Beauty (₹300 + ₹400; ₹354 +
 *   ₹472 = ₹826), the painter again; never paid: 11 days to D, 908,600 paise-days,
 *   389,400 on Apex and 519,200 on Beauty (by line total).
 * - Old, D−80, Ameerpet: 1 l Apex (₹118) paid D−50: 9 days in the period, 106,200.
 * - C, D, Kukatpally: Lakshmi, 5 l Apex (₹500) paid at once; she returns 2 l, one to the
 *   shelf and one damaged: a ₹200 credit note, ₹65 of cost back.
 * - U, D, the composition counter: Lakshmi, a bill of supply for 1 l Apex (₹118),
 *   paid at once, with no average cost.
 * - Points at ₹1: the contractor earns 10 on A, the homeowner 7 on B (₹100 each); the
 *   painter 10 on A and 11 on B (Apex 3, Beauty 8 by Nerolac's double points).
 *
 * Credit cost at 12 %: Apex at Ameerpet 2,855,600 × 12 % ÷ 365 = ₹9.3882 → 939 paise;
 * Beauty 519,200 → 170.69 → 171 paise.
 */
const apexAmp = figures({
  invoicedPaise: 130_000,
  netSalesPaise: 130_000,
  costPaise: 78_000,
  grossMarginPaise: 52_000,
  creditCostPaise: 939,
  loyaltyPaise: 1_300,
  painterPointsPaise: 1_300,
  contributionPaise: 48_461,
  marginBps: 3_728,
});
const apexKkp = figures({
  invoicedPaise: 50_000,
  creditNotePaise: 20_000,
  netSalesPaise: 30_000,
  costPaise: 26_000,
  grossMarginPaise: 4_000,
  contributionPaise: 4_000,
  marginBps: 1_333,
});
const apexUnr = figures({
  invoicedPaise: 11_800,
  netSalesPaise: 11_800,
  grossMarginPaise: 11_800,
  contributionPaise: 11_800,
  marginBps: 10_000,
});
const beautyAmp = figures({
  invoicedPaise: 40_000,
  netSalesPaise: 40_000,
  costPaise: 30_000,
  grossMarginPaise: 10_000,
  creditCostPaise: 171,
  loyaltyPaise: 400,
  painterPointsPaise: 800,
  contributionPaise: 8_629,
  marginBps: 2_157,
});
const asianTotal = figures({
  invoicedPaise: 191_800,
  creditNotePaise: 20_000,
  netSalesPaise: 171_800,
  costPaise: 104_000,
  grossMarginPaise: 67_800,
  creditCostPaise: 939,
  loyaltyPaise: 1_300,
  painterPointsPaise: 1_300,
  contributionPaise: 64_261,
  marginBps: 3_740,
});

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  const today = await dbToday(t);
  from = await dbToday(t, -59);
  to = today;
  const [brand] = await t.connection.db
    .select({ id: schema.brands.id })
    .from(schema.brands)
    .where(sql`${schema.brands.organizationId} = ${b.organizationId}`);
  asian = String(brand?.id);
  const [product] = await t.connection.db
    .select({ id: schema.products.id })
    .from(schema.products)
    .where(sql`${schema.products.brandId} = ${asian}`);
  apex = String(product?.id);
  nerolac = ok(await owner().post('/brands', { name: 'Nerolac' })).json<{ id: string }>().id;
  berger = ok(await owner().post('/brands', { name: 'Berger' })).json<{ id: string }>().id;
  indigo = ok(await owner().post('/brands', { name: 'Indigo' })).json<{ id: string }>().id;
  const options = ok(await owner().get('/tax-categories/options')).json<{
    categories: { id: string; key: string }[];
  }>();
  const created = ok(
    await owner().post('/products', {
      brandId: nerolac,
      name: 'Beauty Smooth',
      type: 'interior_paint',
      hsnCode: '32091090',
      taxCategoryId: options.categories.find((c) => c.key === 'paints')?.id,
      variants: [{ sku: 'NBS-1L', packSize: 1, unit: 'l', sellingPricePaise: 23_600 }],
    }),
  ).json<{ id: string; variants: { id: string }[] }>();
  beauty = created.id;
  beautyVariant = String(created.variants[0]?.id);

  // The counter registers for composition, so it bills on bills of supply.
  const first14 = '36AABCS1429B2Z';
  ok(
    await owner().put(`/gst-registrations/stores/${b.stores.unr}`, {
      registrationType: 'composition',
      stateCode: '36',
      gstin: `${first14}${gstinCheckCharacter(first14)}`,
      addressLine: '9 Market Road',
      city: 'Hyderabad',
      pincode: '500003',
    }),
  );
  await costedReceipt(b.stores.amp, b.apex, 100, 6_000);
  await costedReceipt(b.stores.kkp, b.apex, 100, 6_500);
  await costedReceipt(b.stores.amp, beautyVariant, 50, 15_000);

  ok(await owner().post('/sales/go-live', { liveOn: await dbToday(t, -100), openings: [] }));
  const painter = await party('Ravi Painter', ['painter'], true);
  const contractor = b.parties.contractor;
  ok(await owner().post(`/parties/${contractor}/loyalty`, {}));
  ok(await owner().post(`/parties/${b.parties.homeowner}/loyalty`, {}));
  const lakshmi = await party('Lakshmi', ['customer'], false);
  for (const partyId of [contractor, b.parties.homeowner]) {
    await t.connection.db.insert(creditProfiles).values({
      organizationId: b.organizationId,
      partyId,
      status: 'active',
      limitPaise: 100_000_000,
      creditDays: 30,
    });
  }
  const rule = {
    basis: 'value',
    points: 1,
    perPaise: 10_000,
    perMillilitres: null,
    multiplierBps: 10_000,
    validFrom: null,
    validUntil: null,
    isActive: true,
  };
  ok(await owner().post('/loyalty-earn-rules', { ...rule, name: 'Every brand', brandId: null }));
  ok(
    await owner().post('/loyalty-earn-rules', {
      ...rule,
      name: 'Nerolac double',
      brandId: nerolac,
      multiplierBps: 20_000,
    }),
  );

  const a = await sale(b.stores.amp, contractor, [{ variantId: b.apex, quantity: 10 }], {
    influencerPartyId: painter,
  });
  await backDate(a.id, 40);
  await pay(b.stores.amp, contractor, a, await dbToday(t, -20));

  const bill = await sale(
    b.stores.amp,
    b.parties.homeowner,
    [
      { variantId: b.apex, quantity: 3 },
      { variantId: beautyVariant, quantity: 2 },
    ],
    { influencerPartyId: painter },
  );
  await backDate(bill.id, 10);

  const old = await sale(b.stores.amp, b.parties.homeowner, [{ variantId: b.apex, quantity: 1 }]);
  await backDate(old.id, 80);
  await pay(b.stores.amp, b.parties.homeowner, old, await dbToday(t, -50));

  const paidAtOnce = (total: number) => ({
    issue: { payments: [{ modeId: b.modes.upi.id, amountPaise: total, reference: 'UPI-NOW' }] },
  });
  const c = await sale(
    b.stores.kkp,
    lakshmi,
    [{ variantId: b.apex, quantity: 5 }],
    paidAtOnce(59_000),
  );
  ok(
    await owner().post('/sales-returns', {
      invoiceId: c.id,
      lines: [
        { invoiceLineId: c.lines[0]?.id, quantity: 1, disposition: 'restock' },
        { invoiceLineId: c.lines[0]?.id, quantity: 1, disposition: 'damage', reason: 'Dented' },
      ],
    }),
  );
  const u = await sale(
    b.stores.unr,
    lakshmi,
    [{ variantId: b.apex, quantity: 1 }],
    paidAtOnce(11_800),
  );
  expect([u.kind, u.taxablePaise]).toEqual(['bill_of_supply', 11_800]);
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

/** Every brand's slices add up to the brand. */
function expectSlicesAddUp(result: BrandProfitabilityView) {
  for (const brand of result.brands) {
    expect(sumMargins(brand.slices)).toEqual(brand.figures);
  }
  expect(sumMargins(result.brands.map((brand) => brand.figures))).toEqual(result.total);
}

describe('brand profitability', () => {
  it('computes every component of every brand, product and store by hand', async () => {
    const byStore = await view('groupBy=store');
    expect(byStore).toMatchObject({
      from,
      to,
      groupBy: 'store',
      costOfMoneyBps: 1_200,
      pointValuePaise: 100,
      schemesCounted: true,
      uncostedLines: 1,
    });
    expect(byStore.brands.map((brand) => [brand.brandName, brand.uncostedLines])).toEqual([
      ['Asian Paints', 1],
      ['Nerolac', 0],
    ]);
    const [asianRow, nerolacRow] = byStore.brands;
    expect(asianRow?.figures).toEqual(asianTotal);
    expect(asianRow?.slices).toEqual([
      {
        ...apexAmp,
        productId: null,
        productName: null,
        storeId: b.stores.amp,
        storeCode: 'AMP',
        storeName: 'Ameerpet',
      },
      {
        ...apexUnr,
        productId: null,
        productName: null,
        storeId: b.stores.unr,
        storeCode: 'UNR',
        storeName: 'Godown counter',
      },
      {
        ...apexKkp,
        productId: null,
        productName: null,
        storeId: b.stores.kkp,
        storeCode: 'KKP',
        storeName: 'Kukatpally',
      },
    ]);
    expect(nerolacRow?.figures).toEqual(beautyAmp);
    expect(byStore.total).toEqual(
      figures({
        invoicedPaise: 231_800,
        creditNotePaise: 20_000,
        netSalesPaise: 211_800,
        costPaise: 134_000,
        grossMarginPaise: 77_800,
        creditCostPaise: 1_110,
        loyaltyPaise: 1_700,
        painterPointsPaise: 2_100,
        contributionPaise: 72_890,
        marginBps: 3_441,
      }),
    );
    expectSlicesAddUp(byStore);
  });

  it('answers by brand, or by product, with the same brand totals', async () => {
    const byBrand = await view('');
    expect(byBrand.brands.map((brand) => [brand.brandId, brand.slices])).toEqual([
      [asian, []],
      [nerolac, []],
    ]);
    expect(byBrand.brands[0]?.figures).toEqual(asianTotal);
    const byProduct = await view('groupBy=product');
    expect(byProduct.brands[0]?.slices).toEqual([
      {
        ...asianTotal,
        productId: apex,
        productName: 'Apex Ultima',
        storeId: null,
        storeCode: null,
        storeName: null,
      },
    ]);
    expect(byProduct.brands[1]?.slices).toEqual([
      {
        ...beautyAmp,
        productId: beauty,
        productName: 'Beauty Smooth',
        storeId: null,
        storeCode: null,
        storeName: null,
      },
    ]);
    expect(byProduct.total).toEqual(byBrand.total);
    expectSlicesAddUp(byProduct);
  });

  it('keeps to a store, a brand or a product', async () => {
    const kkp = await view(`storeId=${b.stores.kkp}`);
    expect(kkp.brands.map((brand) => [brand.brandName, brand.figures])).toEqual([
      ['Asian Paints', apexKkp],
    ]);
    const nerolacOnly = await view(`brandId=${nerolac}&groupBy=product`);
    expect(nerolacOnly.brands.map((brand) => brand.brandId)).toEqual([nerolac]);
    const beautyOnly = await view(`productId=${beauty}`);
    expect(beautyOnly.brands.map((brand) => [brand.brandId, brand.figures])).toEqual([
      [nerolac, beautyAmp],
    ]);
  });

  it('takes the cost of money and the point value asked for', async () => {
    const result = await view(`costOfMoneyBps=0&pointValuePaise=50&brandId=${nerolac}`);
    expect(result.brands[0]?.figures).toMatchObject({
      creditCostPaise: 0,
      loyaltyPaise: 200,
      painterPointsPaise: 400,
      contributionPaise: 9_400,
    });
  });

  it('covers the last quarter when no period is given, and an empty one shows nothing', async () => {
    const today = await dbToday(t);
    const result = ok(
      await owner().get('/reports/brand-profitability'),
    ).json<BrandProfitabilityView>();
    expect({ from: result.from, to: result.to }).toEqual(previousQuarter(today));
    const empty = ok(
      await owner().get('/reports/brand-profitability?from=2020-01-01&to=2020-03-31'),
    ).json<BrandProfitabilityView>();
    expect(empty).toMatchObject({ brands: [], uncostedLines: 0, total: figures({}) });
  });

  it('refuses a half period, a backwards one or one over a year', async () => {
    const bad = (query: string) => owner().get(`/reports/brand-profitability?${query}`);
    expect(issuesOf(await bad(`from=${from}`))).toEqual(['to']);
    expect(issuesOf(await bad('from=2026-02-01&to=2026-01-01'))).toEqual(['to']);
    expect(issuesOf(await bad('from=2024-01-01&to=2025-01-01'))).toEqual(['to']);
    expect(issuesOf(await bad('groupBy=customer&costOfMoneyBps=10001'))).toEqual([
      'groupBy',
      'costOfMoneyBps',
    ]);
  });

  it('is for those who see the books, at their own stores only', async () => {
    const manager = await b.member('branch_manager', [b.stores.amp]);
    expect((await api(t, manager).get('/reports/brand-profitability')).statusCode).toBe(403);
    expect((await api(t, manager).get('/reports/brand-profitability?format=csv')).statusCode).toBe(
      403,
    );
    const accounts = await accountsMember();
    const theirs = await view('groupBy=store', accounts);
    expect(
      theirs.brands.map((brand) => [brand.brandName, brand.slices.map((s) => s.storeCode)]),
    ).toEqual([['Asian Paints', ['KKP']]]);
    expect(
      (await api(t, accounts).get(`/reports/brand-profitability?storeId=${b.stores.amp}`))
        .statusCode,
    ).toBe(404);
    const reports = ok(await owner().get('/reports')).json<ReportSummary[]>();
    expect(reports.find((report) => report.kind === 'brand-profitability')?.filters).toEqual([
      { name: 'from', type: 'date' },
      { name: 'to', type: 'date' },
      { name: 'storeId', type: 'store' },
      { name: 'groupBy', type: 'enum', values: ['brand', 'product', 'store'] },
    ]);
  });

  it('downloads the same figures as CSV, a row per slice and the total', async () => {
    const reply = ok(
      await owner().get(
        `/reports/brand-profitability?format=csv&from=${from}&to=${to}&groupBy=store`,
      ),
    );
    expect(reply.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(reply.headers['content-disposition']).toMatch(/brand-profitability-/);
    const [header, ...rows] = parseCsv(reply.body.replace(/^\uFEFF/, ''));
    expect(header).toEqual([
      'Brand',
      'Product',
      'Store',
      'Net sales (₹)',
      'Cost of sales (₹)',
      'Gross margin (₹)',
      'Schemes received (₹)',
      'Schemes expected (₹)',
      'Credit cost (₹)',
      'Loyalty points (₹)',
      'Painter points (₹)',
      'Contribution (₹)',
      'Margin (%)',
    ]);
    expect(rows).toEqual([
      [
        'Asian Paints',
        '',
        'AMP',
        '1300.00',
        '780.00',
        '520.00',
        '0.00',
        '0.00',
        '9.39',
        '13.00',
        '13.00',
        '484.61',
        '37.28',
      ],
      [
        'Asian Paints',
        '',
        'UNR',
        '118.00',
        '0.00',
        '118.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '118.00',
        '100.00',
      ],
      [
        'Asian Paints',
        '',
        'KKP',
        '300.00',
        '260.00',
        '40.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '40.00',
        '13.33',
      ],
      [
        'Nerolac',
        '',
        'AMP',
        '400.00',
        '300.00',
        '100.00',
        '0.00',
        '0.00',
        '1.71',
        '4.00',
        '8.00',
        '86.29',
        '21.57',
      ],
      [
        'Total',
        '',
        '',
        '2118.00',
        '1340.00',
        '778.00',
        '0.00',
        '0.00',
        '11.10',
        '17.00',
        '21.00',
        '728.90',
        '34.41',
      ],
    ]);
    const byBrand = ok(
      await owner().get(`/reports/brand-profitability?format=csv&from=2020-01-01&to=2020-01-31`),
    );
    expect(parseCsv(byBrand.body.replace(/^\uFEFF/, '')).slice(1)).toEqual([
      ['Total', '', '', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', ''],
    ]);
    const brandRows = ok(
      await owner().get(`/reports/brand-profitability?format=csv&from=${from}&to=${to}`),
    );
    expect(parseCsv(brandRows.body.replace(/^\uFEFF/, '')).map((row) => row[0])).toEqual([
      'Brand',
      'Asian Paints',
      'Nerolac',
      'Total',
    ]);
  });
});

describe('scheme money', () => {
  const asOwner = async (query: Record<string, string>, schemes: SchemeMoneySource) => {
    const auth = {
      organization: { id: b.organizationId },
      allStores: true,
      storeIds: new Set<string>(),
      permissions: new Set(),
    } as unknown as AuthContext;
    return withTenant(t.connection.db, b.organizationId, (tx) =>
      brandProfitability(tx, auth, brandProfitabilitySchema.parse({ from, to, ...query }), schemes),
    );
  };
  const schemes: SchemeMoneySource = {
    counted: true,
    byBrand: (_tx, organizationId, start, end) => {
      expect([organizationId, start, end]).toEqual([b.organizationId, from, to]);
      return Promise.resolve([
        { brandId: asian, receivedPaise: 10_000, expectedPaise: 5_000 },
        { brandId: berger, receivedPaise: 2_000, expectedPaise: 0 },
        { brandId: indigo, receivedPaise: 1_000, expectedPaise: 1_000 },
      ]);
    },
  };

  it('spreads a brand’s scheme money over its stores by cost, and shows a brand with only schemes', async () => {
    const result = await asOwner({ groupBy: 'store' }, schemes);
    expect(result.schemesCounted).toBe(true);
    const [asianRow, nerolacRow, bergerRow, indigoRow] = result.brands;
    // Berger and Indigo made the same: by name.
    expect(indigoRow?.figures.contributionPaise).toBe(2_000);
    // Cost ₹780 at Ameerpet and ₹260 at Kukatpally (none at the counter): 3 to 1.
    expect(
      asianRow?.slices.map((slice) => [
        slice.storeCode,
        slice.schemeReceivedPaise,
        slice.schemeExpectedPaise,
        slice.contributionPaise,
      ]),
    ).toEqual([
      ['AMP', 7_500, 3_750, 48_461 + 11_250],
      ['UNR', 0, 0, 11_800],
      ['KKP', 2_500, 1_250, 4_000 + 3_750],
    ]);
    expect(asianRow?.figures.contributionPaise).toBe(64_261 + 15_000);
    expect(nerolacRow?.figures).toEqual(beautyAmp);
    expect(bergerRow).toEqual({
      brandId: berger,
      brandName: 'Berger',
      uncostedLines: 0,
      figures: figures({ schemeReceivedPaise: 2_000, contributionPaise: 2_000 }),
      slices: [
        {
          ...figures({ schemeReceivedPaise: 2_000, contributionPaise: 2_000 }),
          productId: null,
          productName: null,
          storeId: null,
          storeCode: null,
          storeName: null,
        },
      ],
    });
    expectSlicesAddUp(result);
    const byProduct = await asOwner({ groupBy: 'product' }, schemes);
    expect(byProduct.brands.at(-1)?.slices.map((slice) => slice.productName)).toEqual([null]);
    expectSlicesAddUp(byProduct);
  });

  it('leaves out brand-only money when narrowed to a store, and shows it alone otherwise', async () => {
    const kkp = await asOwner({ storeId: b.stores.kkp }, schemes);
    expect(kkp.brands.map((brand) => brand.brandName)).toEqual(['Asian Paints']);
    const bergerOnly = await asOwner({ brandId: berger, groupBy: 'store' }, schemes);
    expect(bergerOnly.brands.map((brand) => brand.brandName)).toEqual(['Berger']);
    const none = await asOwner({ brandId: berger }, NO_SCHEME_MONEY);
    expect(none).toMatchObject({ brands: [], schemesCounted: false });
  });
});

describe('scheme money from the schemes module', () => {
  it('adds what the brand issued on a real scheme, spread over its stores by cost', async () => {
    const me = ok(await owner().get('/auth/me')).json<{ memberId: string }>();
    await withTenant(t.connection.db, b.organizationId, async (tx) => {
      const [row] = await tx
        .insert(schema.brandSchemes)
        .values({
          organizationId: b.organizationId,
          brandId: asian,
          name: 'Asian quarter',
          startsOn: from,
          endsOn: to,
          measure: 'value',
          status: 'active',
          createdByMemberId: me.memberId,
        })
        .returning();
      const schemeId = String(row?.id);
      const [slab] = await tx
        .insert(schema.brandSchemeSlabs)
        .values({
          organizationId: b.organizationId,
          schemeId,
          position: 1,
          target: 50_000_00,
        })
        .returning();
      await tx.insert(schema.brandSchemeBenefits).values({
        organizationId: b.organizationId,
        schemeId,
        slabId: String(slab?.id),
        position: 1,
        kind: 'rebate',
        basisPoints: 100,
      });
      // No GRNs reach the slab, so nothing more is expected; the brand sent ₹40 anyway.
      await tx.insert(schema.brandBenefitReceipts).values({
        organizationId: b.organizationId,
        schemeId,
        kind: 'money',
        receivedOn: to,
        amountPaise: 4_000,
        moneyForm: 'credit_note',
        reference: 'AP-CN-1',
        recordedByMemberId: me.memberId,
      });
    });
    const result = await view('groupBy=store');
    expect(result.schemesCounted).toBe(true);
    const asianRow = result.brands.find((brand) => brand.brandId === asian);
    expect(asianRow?.figures).toEqual({
      ...asianTotal,
      schemeReceivedPaise: 4_000,
      contributionPaise: 64_261 + 4_000,
      marginBps: 3_973,
    });
    // Cost ₹780 at Ameerpet, ₹260 at Kukatpally, none at the counter: 3 to 1.
    expect(asianRow?.slices.map((slice) => [slice.storeCode, slice.schemeReceivedPaise])).toEqual([
      ['AMP', 3_000],
      ['UNR', 0],
      ['KKP', 1_000],
    ]);
    expectSlicesAddUp(result);
  });
});

describe('scale', () => {
  it('reads the books in a fixed number of queries, however many there are', async () => {
    const count = async () => {
      const spy = vi.spyOn(pg.Client.prototype, 'query');
      await view('groupBy=product');
      const calls = spy.mock.calls.length;
      spy.mockRestore();
      return calls;
    };
    await count();
    const before = await count();
    const lakshmi = await party('Lakshmi again', ['customer'], false);
    for (const quantity of [1, 2, 3]) {
      await sale(b.stores.kkp, lakshmi, [{ variantId: b.apex, quantity }], {
        issue: {
          payments: [
            { modeId: b.modes.upi.id, amountPaise: 11_800 * quantity, reference: 'UPI-MORE' },
          ],
        },
      });
    }
    expect(await count()).toBe(before);
    // Sign-in, our six reads and three name lookups, and the schemes module's own.
    expect(before).toBeLessThanOrEqual(24);
  });
});
