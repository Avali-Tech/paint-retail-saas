import { migrateDatabase, schema, withTenant, type Transaction } from '@paint/db';
import type {
  LatestReconciliation,
  NotificationPage,
  ReconciliationRunPage,
  ReconciliationRunView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { NotificationsWorker } from '../notifications/notifications-worker.js';
import { Notifier } from '../notifications/notifier.js';
import {
  api,
  billingBusiness,
  dbToday,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';
import { reconcile, RECONCILIATION_PATH } from './reconciler.js';

const { organizations, partyBalances, reconciliationFindings, reconciliationRuns, stockBalances } =
  schema;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let admin: string;
let today: string;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  admin = await b.member('org_admin', []);
  today = await dbToday(t);
  // Some real books: a credit invoice for the contractor.
  await b.invoice({ partyId: b.parties.contractor, quantity: 2 });
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

const owner = () => api(t, b.owner);
const run = async (token = b.owner) =>
  ok(await api(t, token).post('/reconciliation/runs')).json<ReconciliationRunView>();
const latest = async () =>
  ok(await owner().get('/reconciliation/latest')).json<LatestReconciliation>();
const notices = async (token: string) =>
  ok(await api(t, token).get('/notifications?limit=50'))
    .json<NotificationPage>()
    .items.filter((notice) => notice.event === 'reconciliation_mismatch');
const NONE = { stock_on_hand: 0, stock_reserved: 0, party_balance: 0, allocation: 0 };

/** Changes a cached figure behind the API's back, as a bug would. */
async function drift(by: number) {
  await t.connection.db
    .update(stockBalances)
    .set({
      onHand: sql`${stockBalances.onHand} + ${by}`,
      reserved: sql`${stockBalances.reserved} + ${by}`,
    })
    .where(and(eq(stockBalances.storeId, b.stores.kkp), eq(stockBalances.variantId, b.apex)));
  await t.connection.db
    .update(partyBalances)
    .set({ balancePaise: sql`${partyBalances.balancePaise} + ${by * 500}` })
    .where(eq(partyBalances.partyId, b.parties.contractor));
}

describe('reconciliation', () => {
  it('has nothing before the first run, and only for those allowed', async () => {
    expect(await latest()).toEqual({ run: null });
    expect(ok(await owner().get('/reconciliation/runs')).json<ReconciliationRunPage>()).toEqual({
      items: [],
      total: 0,
    });
    const manager = await b.member('branch_manager', [b.stores.amp]);
    expect((await api(t, manager).get('/reconciliation/latest')).statusCode).toBe(403);
    expect((await api(t, manager).post('/reconciliation/runs')).statusCode).toBe(403);
    expect((await owner().get(`/reconciliation/runs/${crypto.randomUUID()}`)).statusCode).toBe(404);
    expect((await owner().get('/reconciliation/runs?limit=0')).statusCode).toBe(400);
  });

  it('runs now and finds the books in balance', async () => {
    const clean = await run();
    expect(clean).toEqual({
      id: expect.any(String),
      trigger: 'manual',
      runOn: today,
      ranAt: expect.any(String),
      requestedBy: { memberId: expect.any(String), name: 'Owner' },
      findingCount: 0,
      counts: NONE,
      findings: [],
    });
    expect(await latest()).toEqual({ run: clean });
    expect(await notices(admin)).toEqual([]);
  });

  it('records every disagreement and tells the people who look after the books', async () => {
    await drift(1);
    const found = await run();
    expect(found).toMatchObject({
      findingCount: 4,
      counts: { stock_on_hand: 1, stock_reserved: 1, party_balance: 1, allocation: 1 },
    });
    expect(found.findings).toEqual([
      {
        id: expect.any(String),
        kind: 'stock_on_hand',
        store: { id: b.stores.kkp, name: 'Kukatpally' },
        variant: { id: b.apex, sku: 'APX-1L', name: 'Apex Ultima 1 l' },
        party: null,
        recorded: 10_001,
        expected: 10_000,
        difference: 1,
        advancePaise: null,
        unallocatedPaise: null,
      },
      {
        id: expect.any(String),
        kind: 'stock_reserved',
        store: { id: b.stores.kkp, name: 'Kukatpally' },
        variant: { id: b.apex, sku: 'APX-1L', name: 'Apex Ultima 1 l' },
        party: null,
        recorded: 1,
        expected: 0,
        difference: 1,
        advancePaise: null,
        unallocatedPaise: null,
      },
      {
        id: expect.any(String),
        kind: 'party_balance',
        store: null,
        variant: null,
        party: { id: b.parties.contractor, name: 'Deccan Contractors' },
        recorded: 24_100,
        expected: 23_600,
        difference: 500,
        advancePaise: null,
        unallocatedPaise: null,
      },
      {
        id: expect.any(String),
        kind: 'allocation',
        store: null,
        variant: null,
        party: { id: b.parties.contractor, name: 'Deccan Contractors' },
        recorded: 24_100,
        expected: 23_600,
        difference: 500,
        advancePaise: 0,
        unallocatedPaise: 0,
      },
    ]);
    // The owner asked and sees the answer; the admin is told.
    expect(await notices(b.owner)).toEqual([]);
    expect(await notices(admin)).toEqual([
      expect.objectContaining({
        title: 'The books are out of balance: 4 finding(s)',
        body: [
          'Stock on hand differs from the stock ledger: 1',
          'Stock reserved differs from open reservations: 1',
          'Party balances differ from the party ledger: 1',
          'Allocations disagree with party balances: 1',
        ].join('\n'),
        link: RECONCILIATION_PATH,
      }),
    ]);

    expect(ok(await owner().get(`/reconciliation/runs/${found.id}`)).json()).toEqual(found);
    expect(await latest()).toEqual({ run: found });
    const page = ok(
      await owner().get('/reconciliation/runs?limit=1&offset=1'),
    ).json<ReconciliationRunPage>();
    expect(page.total).toBe(2);
    expect(page.items).toEqual([expect.objectContaining({ findingCount: 0, counts: NONE })]);
  });

  it('runs every night, once a day per business, skipping suspended ones', async () => {
    const suspended = await billingBusiness(t);
    await t.connection.db
      .update(organizations)
      .set({ suspendedAt: sql`now()`, suspendReason: 'Unpaid' })
      .where(eq(organizations.id, suspended.organizationId));
    const worker = t.app.get(NotificationsWorker);

    expect((await worker.runOnce()).reconciliations).toBe(1);
    expect((await worker.runOnce()).reconciliations).toBe(0);
    const nightly = (await latest()).run;
    expect(nightly).toMatchObject({
      trigger: 'scheduled',
      runOn: today,
      requestedBy: null,
      findingCount: 4,
    });
    // Nobody asked for this one: everyone who looks after the books hears.
    expect(await notices(b.owner)).toHaveLength(1);
    expect(await notices(admin)).toHaveLength(2);
    const [none] = await t.connection.db
      .select({ value: sql<number>`count(*)::int` })
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.organizationId, suspended.organizationId));
    expect(none?.value).toBe(0);

    // Another server reaching the same business the same day records nothing.
    const again = await withTenant(t.connection.db, b.organizationId, (tx) =>
      reconcile(tx, t.app.get(Notifier), {
        organizationId: b.organizationId,
        trigger: 'scheduled',
      }),
    );
    expect(again).toBeNull();
    await drift(-1);
    expect((await run()).findingCount).toBe(0);
    // Only the party's balance drifts: the notice names just what disagrees.
    await t.connection.db
      .update(partyBalances)
      .set({ balancePaise: sql`${partyBalances.balancePaise} + 100` })
      .where(eq(partyBalances.partyId, b.parties.contractor));
    expect((await run()).counts).toEqual({ ...NONE, party_balance: 1, allocation: 1 });
    expect((await notices(admin))[0]?.body).toBe(
      [
        'Party balances differ from the party ledger: 1',
        'Allocations disagree with party balances: 1',
      ].join('\n'),
    );
    await t.connection.db
      .update(partyBalances)
      .set({ balancePaise: sql`${partyBalances.balancePaise} - 100` })
      .where(eq(partyBalances.partyId, b.parties.contractor));
  });

  it('keeps runs and findings as a permanent record', async () => {
    const refusal = (pattern: RegExp) => ({
      cause: expect.objectContaining({ message: expect.stringMatching(pattern) }),
    });
    const tenant = (work: (tx: Transaction) => Promise<unknown>) =>
      withTenant(t.connection.db, b.organizationId, work);
    await expect(
      tenant((tx) => tx.update(reconciliationRuns).set({ findingCount: 9 })),
    ).rejects.toMatchObject(refusal(/permission denied/));
    await expect(tenant((tx) => tx.delete(reconciliationFindings))).rejects.toMatchObject(
      refusal(/permission denied/),
    );
    // Not even the owner of the tables.
    await expect(t.connection.db.delete(reconciliationFindings)).rejects.toMatchObject(
      refusal(/reconciliation_findings is append-only/),
    );
    await expect(
      t.connection.db.execute(sql`truncate ${reconciliationRuns} cascade`),
    ).rejects.toMatchObject(refusal(/reconciliation_runs is append-only/));
  });
});
