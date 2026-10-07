import { randomUUID } from 'node:crypto';
import { findStockMismatches, schema } from '@paint/db';
import { withPgClient } from '@paint/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, TEST_AUTH_SECRET, type TestApp } from '../test-support/test-app.js';
import { LARGE_SHAPED_TEST_SCALE as scale } from './large-plan.js';
import { DEMO_PASSWORD } from './plan.js';
import { runSeedCommand } from './seed-command.js';

// The large demo at about 1/50 of its size: the same code paths, quick enough for CI.
const serverUrl = inject('databaseUrl');
const demoUrl = (() => {
  const url = new URL(serverUrl);
  url.pathname = `/demo_large_${randomUUID().replaceAll('-', '')}`;
  return url.toString();
})();

let t: TestApp;
let owner: string;
let output: string;

const get = async <T>(url: string, token = owner) => {
  const response = await t.app.inject({ method: 'GET', url, headers: bearer(token) });
  expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
  return response.json<T>();
};
const one = async <T>(query: ReturnType<typeof sql>) =>
  (await t.connection.db.execute<T & Record<string, unknown>>(query)).rows[0] as T;

beforeAll(async () => {
  const lines: string[] = [];
  const code = await runSeedCommand(
    'seed',
    { DATABASE_URL: demoUrl, AUTH_SECRET: TEST_AUTH_SECRET, DEMO_SIZE: 'large' },
    (line) => lines.push(line),
    scale,
  );
  output = lines.join('\n');
  expect(code, output).toBe(0);
  t = await startTestApp(demoUrl);
  const login = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier: '+919000000001', password: DEMO_PASSWORD },
  });
  owner = login.json<{ token: string }>().token;
}, 300_000);

afterAll(async () => {
  await t.close();
  await withPgClient(serverUrl, (client) =>
    client.query(`DROP DATABASE IF EXISTS "${new URL(demoUrl).pathname.slice(1)}" WITH (FORCE)`),
  );
});

describe('the large demo', () => {
  it('adds the large shop on top of the full demo', async () => {
    expect(output).toContain('Seeding Sharma Paints & Hardware (large)');
    expect(output).toMatch(new RegExp(`Seeded in \\d+ s: ${String(3 + scale.extraStores)} stores`));
    expect(output).toContain(`${String(scale.otherBusinesses)} other businesses`);
    const businesses = await one<{ count: number }>(
      sql`select count(*)::int as count from ${schema.organizations}`,
    );
    expect(businesses.count).toBe(1 + scale.otherBusinesses);
    const stores = await get<unknown[]>('/stores');
    expect(stores).toHaveLength(3 + scale.extraStores);
    const products = await get<{ total: number }>('/products?limit=1');
    expect(products.total).toBe(82 + scale.products);
    const parties = await get<{ total: number }>('/parties?limit=1');
    expect(parties.total).toBeGreaterThan(84 + scale.parties - 10);
    const leads = await get<{ total: number }>('/leads?limit=1');
    expect(leads.total).toBe(22 + scale.leads);
    const documents = await get<{ total: number; items: { recordLabel: string }[] }>(
      '/documents?limit=5',
    );
    expect(documents.total).toBeGreaterThan(scale.documents * 0.9);
    expect(documents.items.every((document) => document.recordLabel !== '')).toBe(true);
  });

  it("gives each new store its staff, who see only their store's customers and leads", async () => {
    const login = await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { identifier: '+919000000050', password: DEMO_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    const manager = login.json<{ token: string }>().token;
    const me = await get<{ storeIds: string[]; role: { key: string } }>('/auth/me', manager);
    expect(me.role.key).toBe('branch_manager');
    expect(me.storeIds).toHaveLength(1);
    const parties = await get<{ items: { homeStoreId: string | null }[]; total: number }>(
      '/parties?limit=200',
      manager,
    );
    expect(parties.total).toBeGreaterThan(0);
    expect(
      parties.items.every(
        (party) => party.homeStoreId === null || party.homeStoreId === me.storeIds[0],
      ),
    ).toBe(true);
    const leads = await get<{ items: { store: { id: string } }[]; total: number }>(
      '/leads?limit=200',
      manager,
    );
    expect(leads.total).toBeGreaterThan(0);
    expect(leads.total).toBeLessThan(scale.leads);
    expect(leads.items.every((lead) => lead.store.id === me.storeIds[0])).toBe(true);
  });

  it('keeps every balance equal to its ledger, never negative', async () => {
    expect(await findStockMismatches(t.connection.db)).toEqual([]);
    const ledger = await one<{ entries: number; negative: number }>(sql`
      select (select count(*)::int from ${schema.stockLedger}) as entries,
             (select count(*)::int from ${schema.stockBalances} where on_hand < 0) as negative`);
    expect(ledger.negative).toBe(0);
    expect(ledger.entries).toBeGreaterThan(scale.ledgerEntries * 0.8);
    const low = await get<{ total: number }>('/stock/low?limit=1');
    expect(low.total).toBeGreaterThan(0);
  });

  it('writes every row inside the business, so row-level security shows it', async () => {
    const [organization] = (
      await t.connection.db
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(sql`${schema.organizations.name} = 'Sharma Paints & Hardware'`)
    ).map((row) => row.id);
    for (const table of [
      schema.parties,
      schema.productVariants,
      schema.stockLedger,
      schema.leads,
      schema.activities,
      schema.documents,
      schema.notifications,
      schema.loyaltyLedger,
    ]) {
      const outside = await one<{ count: number }>(
        sql`select count(*)::int as count from ${table} where organization_id <> ${organization}`,
      );
      expect(outside.count).toBe(0);
    }
  });

  it('continues every document number series', async () => {
    const customer = await get<{ items: { id: string }[] }>('/parties?role=customer&limit=1');
    const stores = await get<{ id: string; code: string }[]>('/stores');
    const created = await t.app.inject({
      method: 'POST',
      url: '/leads',
      headers: bearer(owner),
      payload: {
        storeId: stores[0]?.id,
        partyId: customer.items[0]?.id,
        title: 'One more',
        source: 'walk_in',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json<{ number: string }>().number).toBe(
      `LD-${String(22 + scale.leads + 1).padStart(6, '0')}`,
    );
  });

  it('back-dates the history, the audit log of write-offs included', async () => {
    const times = await one<{ oldest: string; audits: number; recent: number }>(sql`
      select (select min(created_at)::text from ${schema.stockLedger}) as oldest,
             (select count(*)::int from ${schema.auditLog} where table_name = 'stock_ledger') as audits,
             (select count(*)::int from ${schema.auditLog} a join ${schema.stockLedger} l on l.id::text = a.record_id
               where a.occurred_at <> l.created_at) as recent`);
    expect(Date.parse(times.oldest)).toBeLessThan(
      Date.now() - (scale.historyDays - 2) * 86_400_000,
    );
    expect(times.audits).toBeGreaterThan(0);
    expect(times.recent).toBe(0);
    const audit = await get<{ items: { recordLabel: string | null }[] }>(
      '/audit-log?table=stock_ledger&limit=5',
    );
    expect(audit.items.every((entry) => entry.recordLabel !== null)).toBe(true);
  });

  it('has follow-ups for today, loyalty balances never below zero and a quiet bell', async () => {
    const followUps = await get<{ counts: { overdue: number; today: number } }>(
      '/activities/follow-ups?when=open&assignedTo=everyone',
    );
    expect(followUps.counts.overdue).toBeGreaterThan(0);
    const accounts = await get<{ items: { balance: number }[] }>('/loyalty-accounts?limit=200');
    expect(accounts.items.length).toBeGreaterThan(scale.loyaltyAccounts / 2);
    expect(accounts.items.every((account) => account.balance >= 0)).toBe(true);
    const bell = await get<{ unread: number; items: unknown[] }>('/notifications');
    expect(bell.items.length).toBeGreaterThan(0);
    // Already-announced low stock and follow-ups were not announced again by the worker.
    expect(bell.unread).toBeLessThan(scale.notifications / 2);
    const dashboard = await get<{ totals: { stock: { valuePaise: number } } }>('/dashboard');
    expect(dashboard.totals.stock.valuePaise).toBeGreaterThan(0);
  });
});
