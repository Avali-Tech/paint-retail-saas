import { appendFileSync } from 'node:fs';
import { migrateDatabase, runAsMember, withTenant, type TenantTransaction } from '@paint/db';
import type {
  AuthProfile,
  BrandProfitabilityView,
  PriceHikePlanView,
  SchemeClaimsReport,
  SchemeDetail,
  SchemeSummary,
  SchemesOverview,
  TaxCategoryOptions,
} from '@paint/shared';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { planReceivables, writeReceivables } from '../demo/bulk-receivables.js';
import { Random } from '../demo/random.js';
import {
  api,
  billingBusiness,
  dbToday,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { writeBrandMoneyBooks, type BrandMoneyBooks } from '../test-support/brand-money-books.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';

/**
 * Brand schemes, the price-hike planner and brand profitability at a large shop's
 * volume (MVP 3 round 6b, docs/performance.md): 20 brands with 500 products in 1,000
 * packs, a year of 3,000 GRNs from their distributors, 10,000 sale invoices drawing the
 * stock down (with credit notes), 100 schemes (quarterly, past and running, and yearly)
 * with receipts and claims, and 600 credit customers' paid and unpaid books. Each read
 * must stay inside generous time limits (CI is slow, coverage slower) and must not run
 * more queries as schemes, brands or invoices grow: an N+1 shows as a query count first.
 *
 * Set BRAND_MONEY_SCALE_REPORT to a file to append the measured times.
 */

const SCALE = {
  brands: 20,
  productsPerBrand: 25,
  grns: 3_000,
  linesPerGrn: 6,
  invoices: 10_000,
  linesPerInvoice: 3,
  days: 365,
  creditNoteEvery: 40,
} as const;
const CREDIT_CUSTOMERS = 600;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let books: BrandMoneyBooks;
let today: string;
let busiest: string;
let yearly: string;
/** The brand bought least, and its yearly scheme. */
let quietBrand: string;
let quietYearly: string;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  today = await dbToday(t);
  const owner = ok(await api(t, b.owner).get('/auth/me')).json<AuthProfile>();
  const options = ok(
    await api(t, b.owner).get('/tax-categories/options'),
  ).json<TaxCategoryOptions>();
  const taxCategoryId = String(options.categories.find((c) => c.key === 'paints')?.id);

  await withPgClient(database.connectionString, async (client) => {
    await client.query(
      `INSERT INTO parties (organization_id, display_name, phone, home_store_id)
       SELECT $1, 'Scale Customer ' || g, '+9178' || lpad(g::text, 8, '0'),
              CASE WHEN g % 2 = 0 THEN $2::uuid ELSE $3::uuid END
       FROM generate_series(1, ${String(CREDIT_CUSTOMERS)}) g`,
      [b.organizationId, b.stores.amp, b.stores.kkp],
    );
    await client.query(
      `INSERT INTO party_roles (organization_id, party_id, role)
       SELECT organization_id, id, 'customer' FROM parties
       WHERE organization_id = $1 AND display_name LIKE 'Scale Customer %'`,
      [b.organizationId],
    );
  });
  const customers = await withPgClient(database.connectionString, (client) =>
    client.query<{ id: string; name: string; store: string }>(
      `SELECT id, display_name AS name, home_store_id AS store FROM parties
       WHERE organization_id = $1 AND display_name LIKE 'Scale Customer %' ORDER BY phone`,
      [b.organizationId],
    ),
  );
  ok(await api(t, b.owner).post('/sales/go-live', { liveOn: await dbToday(t, -SCALE.days) }));

  const random = new Random(20_261_016);
  const now = new Date();
  const tenant = <T>(work: (tx: TenantTransaction) => Promise<T>) =>
    runAsMember(owner.memberId, () => withTenant(t.connection.db, b.organizationId, work));
  books = await tenant((tx) =>
    writeBrandMoneyBooks(
      tx,
      random,
      {
        organizationId: b.organizationId,
        memberId: owner.memberId,
        storeIds: [b.stores.amp, b.stores.kkp],
        customerIds: customers.rows.map((row) => row.id),
        taxCategoryId,
        now,
      },
      SCALE,
    ),
  );
  const receivables = planReceivables(
    random,
    {
      organizationId: b.organizationId,
      stores: [
        { id: b.stores.amp, memberId: owner.memberId },
        { id: b.stores.kkp, memberId: owner.memberId },
      ],
      customers: customers.rows.map((customer) => ({
        id: customer.id,
        name: customer.name,
        store: customer.store === b.stores.amp ? 0 : 1,
        projectIds: [],
      })),
      modes: [
        { id: b.modes.bank.id, kind: 'bank_transfer' },
        { id: b.modes.upi.id, kind: 'upi' },
      ],
      liveDaysAgo: SCALE.days,
      now,
    },
    { creditCustomers: CREDIT_CUSTOMERS, invoicesPerCustomer: 6 },
  );
  await tenant((tx) => writeReceivables(tx, b.organizationId, receivables));

  // Five schemes a brand: three finished quarters (the oldest closed), the running
  // quarter, and a yearly litres scheme; claims filed and part paid on the finished ones.
  [busiest = ''] = books.brandIds;
  const post = async <T>(url: string, body: object = {}) =>
    ok(await api(t, b.owner).post(url, body)).json<T>();
  for (const brandId of books.brandIds) {
    const quarters = [
      [-360, -271],
      [-270, -181],
      [-180, -91],
      [-60, 29],
    ] as const;
    for (const [index, [start, end]] of quarters.entries()) {
      const scheme = await post<{ id: string }>('/brand-schemes', {
        brandId,
        name: `Quarter ${String(index + 1)}`,
        startsOn: await dbToday(t, start),
        endsOn: await dbToday(t, end),
        measure: 'value',
        settlementDays: 30,
        slabs: [
          { target: 2_00_000_00, benefits: [{ kind: 'rebate', basisPoints: 100 }] },
          { target: 5_00_000_00, benefits: [{ kind: 'rebate', basisPoints: 200 }] },
          { target: 10_00_000_00, benefits: [{ kind: 'points', label: 'Trip', points: 1 }] },
        ],
      });
      await post(`/brand-schemes/${scheme.id}/activate`);
      if (end > 0) continue;
      await post(`/brand-schemes/${scheme.id}/claims`, { filedOn: await dbToday(t, end + 10) });
      await post(`/brand-schemes/${scheme.id}/receipts`, {
        kind: 'money',
        amountPaise: 1_000_00,
        moneyForm: 'credit_note',
        receivedOn: await dbToday(t, end + 20),
      });
      if (index === 0) await post(`/brand-schemes/${scheme.id}/close`, { note: 'Settled' });
    }
    const year = await post<{ id: string }>('/brand-schemes', {
      brandId,
      name: 'Yearly litres',
      startsOn: await dbToday(t, -300),
      endsOn: await dbToday(t, 64),
      measure: 'litres',
      slabs: [
        { target: 5_000_000, benefits: [{ kind: 'per_litre', paisePerLitre: 200 }] },
        { target: 20_000_000, benefits: [{ kind: 'per_litre', paisePerLitre: 400 }] },
      ],
    });
    await post(`/brand-schemes/${year.id}/activate`);
    if (brandId === busiest) yearly = year.id;
    if (brandId === books.brandIds.at(-1)) {
      quietBrand = brandId;
      quietYearly = year.id;
    }
  }
  await withPgClient(database.connectionString, (client) => client.query('ANALYZE'));
  const report = process.env.BRAND_MONEY_SCALE_REPORT;
  if (report !== undefined) appendFileSync(report, `${JSON.stringify(books)}\n`);
}, 900_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

/** Median wall time of five calls after one to warm up, and the queries a call runs. */
async function measure(
  url: string,
  body?: object,
): Promise<{ ms: number; queries: number; bytes: number }> {
  const call = async () =>
    ok(body === undefined ? await api(t, b.owner).get(url) : await api(t, b.owner).post(url, body));
  const bytes = (await call()).body.length;
  // The fewest of three calls: an occasional write (a session's last use) is not the read's.
  const counts: number[] = [];
  for (let run = 0; run < 3; run += 1) {
    const spy = vi.spyOn(pg.Client.prototype, 'query');
    await call();
    counts.push(spy.mock.calls.length);
    spy.mockRestore();
  }
  const queries = Math.min(...counts);
  const times: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    const start = performance.now();
    await call();
    times.push(performance.now() - start);
  }
  const ms = Math.round(times.sort((x, y) => x - y)[2] ?? 0);
  const report = process.env.BRAND_MONEY_SCALE_REPORT;
  if (report !== undefined) {
    appendFileSync(
      report,
      `${url}\t${String(ms)} ms\t${String(queries)} queries\t${String(Math.round(bytes / 1024))} KB\n`,
    );
  }
  return { ms, queries, bytes };
}

describe(
  `brand money at a large shop (${String(SCALE.brands)} brands, ${String(SCALE.grns)} GRNs, ${String(SCALE.invoices)} invoices)`,
  { timeout: 300_000 },
  () => {
    it('wrote the volume it says', () => {
      expect(books).toMatchObject({
        products: 500,
        variants: 1_000,
        grns: 3_000,
        grnLines: 18_000,
      });
      expect(books.invoices).toBeGreaterThan(9_000);
      expect(books.invoiceLines).toBeGreaterThan(25_000);
      expect(books.creditNotes).toBeGreaterThan(200);
    });

    it('lists every scheme with its progress and claim quickly, in a fixed number of queries', async () => {
      const all = await measure('/brand-schemes');
      const one = await measure(`/brand-schemes?brandId=${busiest}`);
      const active = await measure('/brand-schemes?status=active');
      const overview = await measure('/brand-schemes/overview');
      const claims = await measure('/brand-schemes/claims');
      // A hundred schemes over twenty brands run the queries one brand's five do.
      expect([all.queries, active.queries]).toEqual([one.queries, one.queries]);
      expect(Math.max(all.queries, overview.queries, claims.queries)).toBeLessThanOrEqual(16);
      expect(Math.max(all.ms, active.ms, overview.ms, claims.ms)).toBeLessThan(4_000);
      expect(ok(await api(t, b.owner).get('/brand-schemes')).json<SchemeSummary[]>()).toHaveLength(
        100,
      );
      expect(
        ok(await api(t, b.owner).get('/brand-schemes/overview')).json<SchemesOverview>(),
      ).toMatchObject({ activeSchemes: 80 });
      expect(
        ok(await api(t, b.owner).get('/brand-schemes/claims')).json<SchemeClaimsReport>().rows,
      ).toHaveLength(100);
    });

    it("opens the busiest brand's yearly scheme quickly, in the queries of a quiet one", async () => {
      const busy = await measure(`/brand-schemes/${yearly}`);
      const quiet = await measure(`/brand-schemes/${quietYearly}`);
      expect(busy.queries).toBe(quiet.queries);
      expect(busy.queries).toBeLessThanOrEqual(16);
      expect(busy.ms).toBeLessThan(3_000);
      const scheme = ok(await api(t, b.owner).get(`/brand-schemes/${yearly}`)).json<SchemeDetail>();
      expect(scheme.grnLines.length).toBeGreaterThan(1_000);
    });

    it('plans a price hike for the brand with the most packs quickly', async () => {
      const effectiveOn = await dbToday(t, 14);
      const body = (brandId: string) => ({
        brandId,
        hikeBasisPoints: 500,
        effectiveOn,
        productIds: [],
        categoryIds: [],
      });
      const busy = await measure('/brand-schemes/price-hike-plan', body(busiest));
      const quiet = await measure('/brand-schemes/price-hike-plan', body(quietBrand));
      expect(busy.queries).toBe(quiet.queries);
      expect(busy.queries).toBeLessThanOrEqual(16);
      expect(busy.ms).toBeLessThan(3_000);
      const plan = ok(
        await api(t, b.owner).post('/brand-schemes/price-hike-plan', body(busiest)),
      ).json<PriceHikePlanView>();
      expect(plan.skus).toHaveLength(50);
    });

    it('works out brand profitability for a quarter and a year quickly, in a fixed number of queries', async () => {
      const quarterRange = `from=${await dbToday(t, -90)}&to=${today}`;
      const yearRange = `from=${await dbToday(t, -SCALE.days + 1)}&to=${today}`;
      const quarter = await measure(`/reports/brand-profitability?${quarterRange}`);
      const year = await measure(`/reports/brand-profitability?${yearRange}`);
      const others = [];
      for (const url of [
        '/reports/brand-profitability',
        '/reports/brand-profitability?groupBy=product',
        '/reports/brand-profitability?groupBy=store',
        `/reports/brand-profitability?${yearRange}&groupBy=product`,
      ]) {
        others.push({ url, ...(await measure(url)) });
      }
      expect(year.queries).toBe(quarter.queries);
      expect(year.queries).toBeLessThanOrEqual(28);
      expect(quarter.ms).toBeLessThan(6_000);
      expect(year.ms).toBeLessThan(10_000);
      for (const { url, ms } of others) {
        expect({ url, fast: ms < 10_000 }).toEqual({ url, fast: true });
      }
      const view = ok(
        await api(t, b.owner).get(`/reports/brand-profitability?${yearRange}`),
      ).json<BrandProfitabilityView>();
      expect(view.brands).toHaveLength(SCALE.brands);
      expect(view.uncostedLines).toBe(0);
    });

    it('exports the scheme, claims and profitability reports quickly', async () => {
      for (const url of [
        '/reports/brand-schemes?format=csv',
        '/reports/brand-scheme-claims?format=csv',
        '/reports/brand-profitability?format=csv&groupBy=product',
      ]) {
        const { ms } = await measure(url);
        expect({ url, fast: ms < 8_000 }).toEqual({ url, fast: true });
      }
    });
  },
);
