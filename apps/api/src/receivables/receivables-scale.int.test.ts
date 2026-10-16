import { appendFileSync } from 'node:fs';
import { migrateDatabase, runAsMember, withTenant } from '@paint/db';
import { type AuthProfile, type SiteAccountView } from '@paint/shared';
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
import { startTestApp, type TestApp } from '../test-support/test-app.js';

/**
 * Receivables, collections, credit and statements at a large shop's volume (MVP 3
 * pilot readiness): 1,500 credit customers with about 9,000 bills on account, their
 * payments, holds, site accounts and promises, written by the large demo's bulk
 * writer. Each read must stay well inside generous time limits (CI machines are slow
 * and coverage slows the code), and must not run more queries as the page or the
 * books grow: an N+1 would show as a query count, before it shows as time.
 *
 * Set RECEIVABLES_SCALE_REPORT to a file to append the measured times (docs/performance.md).
 */

const CUSTOMERS = 1_500;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let salesperson: string;
let busiest: string;
let siteId: string;
let siteParty: string;
let siteProjectId: string;
let draftId: string;
let today: string;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  today = await dbToday(t);
  const owner = ok(await api(t, b.owner).get('/auth/me')).json<AuthProfile>();
  salesperson = await b.member('sales_executive', [b.stores.amp, b.stores.kkp]);
  const salesId = ok(await api(t, salesperson).get('/auth/me')).json<AuthProfile>().memberId;

  // Customers in bulk, two in three looked after by the salesperson.
  await withPgClient(database.connectionString, async (client) => {
    await client.query(
      `INSERT INTO parties (organization_id, display_name, phone, home_store_id)
       SELECT $1, 'Scale Customer ' || g, '+9179' || lpad(g::text, 8, '0'),
              CASE WHEN g % 2 = 0 THEN $2::uuid ELSE $3::uuid END
       FROM generate_series(1, ${String(CUSTOMERS)}) g`,
      [b.organizationId, b.stores.amp, b.stores.kkp],
    );
    await client.query(
      `INSERT INTO party_roles (organization_id, party_id, role)
       SELECT organization_id, id, 'customer' FROM parties
       WHERE organization_id = $1 AND display_name LIKE 'Scale Customer %'`,
      [b.organizationId],
    );
    await client.query(
      `INSERT INTO customer_profiles (organization_id, party_id, customer_type, assigned_member_id)
       SELECT organization_id, id, 'contractor',
              CASE WHEN substring(phone from 10)::int % 3 = 0 THEN NULL ELSE $2::uuid END
       FROM parties WHERE organization_id = $1 AND display_name LIKE 'Scale Customer %'`,
      [b.organizationId, salesId],
    );
  });
  const customers = await withPgClient(database.connectionString, (client) =>
    client.query<{ id: string; name: string; store: string }>(
      `SELECT id, display_name AS name, home_store_id AS store FROM parties
       WHERE organization_id = $1 AND display_name LIKE 'Scale Customer %' ORDER BY phone`,
      [b.organizationId],
    ),
  );
  // Sites: projects of the first 40 customers.
  const projectsOf = new Map<string, string[]>();
  for (const customer of customers.rows.slice(0, 40)) {
    const project = ok(
      await api(t, b.owner).post('/projects', {
        storeId: customer.store,
        customerPartyId: customer.id,
        name: `Site of ${customer.name}`,
      }),
    ).json<{ id: string }>();
    projectsOf.set(customer.id, [project.id]);
  }
  ok(await api(t, b.owner).post('/sales/go-live', { liveOn: await dbToday(t, -60) }));

  const plan = planReceivables(
    new Random(20_261_016),
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
        projectIds: projectsOf.get(customer.id) ?? [],
      })),
      modes: [
        { id: b.modes.bank.id, kind: 'bank_transfer' },
        { id: b.modes.upi.id, kind: 'upi' },
      ],
      liveDaysAgo: 60,
      now: new Date(),
    },
    { creditCustomers: CUSTOMERS, invoicesPerCustomer: 6 },
  );
  await runAsMember(owner.memberId, () =>
    withTenant(t.connection.db, b.organizationId, (tx) =>
      writeReceivables(tx, b.organizationId, plan),
    ),
  );
  await withPgClient(database.connectionString, (client) => client.query('ANALYZE'));

  // The customer with the most bills, a site account and a draft to check at issue.
  const owed = new Map<string, number>();
  for (const invoice of plan.invoices) {
    owed.set(String(invoice.partyId), (owed.get(String(invoice.partyId)) ?? 0) + 1);
  }
  busiest = [...owed].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '';
  const site = plan.sites[0];
  siteProjectId = String(site?.projectId);
  siteParty = String(site?.partyId);
  const sites = ok(await api(t, b.owner).get(`/parties/${String(site?.partyId)}/sites`)).json<
    SiteAccountView[]
  >();
  siteId = String(sites[0]?.id);
  draftId = (await b.draft({ partyId: busiest, lines: [{ variantId: b.apex, quantity: 2 }] })).id;
}, 600_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

/** Median wall time of five calls after one to warm up, and the queries one call runs. */
async function measure(url: string, token = b.owner): Promise<{ ms: number; queries: number }> {
  const call = async () => ok(await api(t, token).get(url));
  await call();
  const spy = vi.spyOn(pg.Client.prototype, 'query');
  await call();
  const queries = spy.mock.calls.length;
  spy.mockRestore();
  const times: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    const start = performance.now();
    await call();
    times.push(performance.now() - start);
  }
  const ms = Math.round(times.sort((x, y) => x - y)[2] ?? 0);
  const report = process.env.RECEIVABLES_SCALE_REPORT;
  if (report !== undefined)
    appendFileSync(report, `${url}\t${String(ms)} ms\t${String(queries)} queries\n`);
  return { ms, queries };
}

const period = () => `from=${String(Number(today.slice(0, 4)) - 1)}-04-01&to=${today}`;

describe(`receivables at a large shop (${String(CUSTOMERS)} credit customers)`, () => {
  it('ages every customer, salesperson and store quickly, in a fixed number of queries', async () => {
    for (const url of [
      '/receivables/summary',
      '/receivables/ageing?limit=50',
      '/receivables/ageing?limit=50&groupBy=salesperson',
      '/receivables/ageing?limit=50&groupBy=store',
      '/receivables/ageing?limit=50&overdueOnly=true&offset=200',
    ]) {
      const { ms, queries } = await measure(url);
      expect({ url, fast: ms < 4_000, queries: queries <= 12 }).toEqual({
        url,
        fast: true,
        queries: true,
      });
    }
    const site = await measure(`/receivables/ageing?limit=50&projectId=${siteProjectId}`);
    expect(site.ms).toBeLessThan(2_000);
  });

  it('lists the collections worklist and escalations quickly', async () => {
    for (const [url, token] of [
      ['/collections/worklist?limit=50', b.owner],
      ['/collections/worklist?limit=50&offset=100', b.owner],
      ['/collections/worklist?limit=50&salespersonId=me', salesperson],
      ['/collections/escalations?limit=50', b.owner],
    ] as const) {
      const { ms, queries } = await measure(url, token);
      expect({ url, fast: ms < 4_000, queries: queries <= 16 }).toEqual({
        url,
        fast: true,
        queries: true,
      });
    }
  });

  it('checks credit exposure without a query per customer', async () => {
    const page = await measure('/credit-profiles?limit=50');
    const longer = await measure('/credit-profiles?limit=200');
    // A page of 200 runs no more queries than a page of 50.
    expect(longer.queries).toBe(page.queries);
    expect(longer.queries).toBeLessThanOrEqual(16);
    expect(longer.ms).toBeLessThan(3_000);
    // A contractor's sites come with their figures, however many it has.
    const one = await measure(`/parties/${siteParty}/sites`);
    for (let site = 0; site < 5; site += 1) {
      const project = ok(
        await api(t, b.owner).post('/projects', {
          storeId: b.stores.amp,
          customerPartyId: siteParty,
          name: `Another site ${String(site)}`,
        }),
      ).json<{ id: string }>();
      ok(
        await api(t, b.owner).post(`/parties/${siteParty}/sites`, {
          projectId: project.id,
          limitPaise: 50_000_00,
        }),
      );
    }
    const six = await measure(`/parties/${siteParty}/sites`);
    expect(six.queries).toBe(one.queries);
    for (const url of [
      `/parties/${busiest}/credit`,
      `/invoices/${draftId}/credit-check?unpaidPaise=23600`,
      `/site-accounts/${siteId}`,
    ]) {
      const { ms } = await measure(url);
      expect({ url, fast: ms < 1_500 }).toEqual({ url, fast: true });
    }
  });

  it("prints the busiest customer's statement and ledger quickly", async () => {
    for (const url of [
      `/parties/${busiest}/statement?${period()}`,
      `/parties/${busiest}/statement.pdf?${period()}`,
      `/parties/${busiest}/ledger`,
    ]) {
      const { ms } = await measure(url);
      expect({ url, fast: ms < 3_000 }).toEqual({ url, fast: true });
    }
  });

  it('exports the ageing and open bills reports quickly', async () => {
    for (const url of [
      '/reports/receivables-ageing?format=csv',
      '/reports/receivables-open-bills?format=csv',
    ]) {
      const { ms } = await measure(url);
      expect({ url, fast: ms < 6_000 }).toEqual({ url, fast: true });
    }
  });
});
