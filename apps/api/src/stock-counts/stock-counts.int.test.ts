import { findStockMismatches, migrateDatabase, schema } from '@paint/db';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

interface Line {
  variantId: string;
  sku: string;
  expectedQuantity: number;
  countedQuantity: number | null;
  variance: number | null;
  varianceValuePaise: number | null;
  reason: string | null;
}
interface Count {
  id: string;
  number: string;
  status: string;
  store: { code: string };
  scope: string;
  closingReason: string | null;
  startedBy: { memberId: string; name: string };
  submittedBy: { memberId: string; name: string } | null;
  submittedAt: string | null;
  approvedAt: string | null;
  summary: {
    totalLines: number;
    countedLines: number;
    uncountedLines: number;
    matchingLines: number;
    accuracyPercent: number | null;
    netVarianceValuePaise: number;
    absoluteVarianceValuePaise: number;
  };
  lines: Line[];
}

let database: TestDatabase;
let t: TestApp;
let owner: string;
let hydManager: string;
let hydSecondManager: string;
let puneManager: string;
let seq = 0;

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object = {}) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
});

async function signup(name: string): Promise<string> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: name,
      fullName: 'Owner',
      phone: uniquePhone(),
      password: 'Staff@2026',
    },
  });
  return response.json<{ token: string }>().token;
}

async function hire(roleKey: string, storeIds: string[]): Promise<string> {
  const roles = (await api(owner).get('/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  await api(owner).post('/members', {
    fullName: `Staff ${roleKey}`,
    phone,
    password: 'Staff@2026',
    roleId: roles.find((role) => role.key === roleKey)?.id,
    storeIds,
  });
  const login = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier: phone, password: 'Staff@2026' },
  });
  return login.json<{ token: string }>().token;
}

interface Setup {
  store: string;
  brandA: string;
  brandB: string;
  category: string;
  /** Brand A, in the category, 10 on hand at ₹100. */
  apex: { id: string; sku: string; barcode: string };
  /** Brand A, no category, 4 on hand without cost. */
  royale: { id: string; sku: string };
  /** Brand B, 6 on hand at ₹50. */
  silk: { id: string; sku: string };
  /** Brand A, never stocked here. */
  spare: { id: string; sku: string };
}

/** A fresh store with stock, so each test counts from a known position. */
async function setup(): Promise<Setup> {
  seq += 1;
  const s = String(seq);
  const store = (await api(owner).post('/stores', { name: `Count ${s}`, code: `CNT${s}` })).json<{
    id: string;
  }>().id;
  const brandA = (await api(owner).post('/brands', { name: `Count A ${s}` })).json<{ id: string }>()
    .id;
  const brandB = (await api(owner).post('/brands', { name: `Count B ${s}` })).json<{ id: string }>()
    .id;
  const parent = (await api(owner).post('/categories', { name: `Walls ${s}` })).json<{
    id: string;
  }>().id;
  const category = (
    await api(owner).post('/categories', { name: `Emulsion ${s}`, parentId: parent })
  ).json<{ id: string }>().id;
  const product = async (brandId: string, name: string, sku: string) =>
    (
      await api(owner).post('/products', {
        brandId,
        name,
        type: 'interior_paint',
        hsnCode: '3209',
        variants: [{ sku, packSize: 1, unit: 'l' }],
      })
    ).json<{ variants: { id: string; sku: string }[] }>().variants[0];
  const barcode = `CNT-BAR-${s}`;
  const apexResponse = await api(owner).post('/products', {
    brandId: brandA,
    categoryId: category,
    name: `Apex ${s}`,
    type: 'interior_paint',
    hsnCode: '3209',
    variants: [{ sku: `APX-${s}`, packSize: 1, unit: 'l', barcodes: [barcode] }],
  });
  const apex = apexResponse.json<{ variants: { id: string; sku: string }[] }>().variants[0];
  const royale = await product(brandA, `Royale ${s}`, `ROY-${s}`);
  const silk = await product(brandB, `Silk ${s}`, `SLK-${s}`);
  const spare = await product(brandA, `Spare ${s}`, `SPR-${s}`);
  await api(owner).post('/stock/movements', {
    storeId: store,
    type: 'opening',
    lines: [
      { variantId: apex?.id, quantity: 10, unitCostPaise: 10_000 },
      { variantId: royale?.id, quantity: 4 },
      { variantId: silk?.id, quantity: 6, unitCostPaise: 5_000 },
    ],
  });
  const pick = (v: { id: string; sku: string } | undefined) => ({
    id: v?.id ?? '',
    sku: v?.sku ?? '',
  });
  return {
    store,
    brandA,
    brandB,
    category,
    apex: { ...pick(apex), barcode },
    royale: pick(royale),
    silk: pick(silk),
    spare: pick(spare),
  };
}

const start = (token: string, payload: object) => api(token).post('/stock-counts', payload);
const counts = (token: string, countId: string, entries: object[]) =>
  api(token).post(`/stock-counts/${countId}/counts`, { entries });

async function stockOf(store: string, variantId: string): Promise<number | undefined> {
  const page = (await api(owner).get(`/stock?storeId=${store}&limit=200`)).json<{
    items: { variant: { id: string }; onHand: number }[];
  }>();
  return page.items.find((row) => row.variant.id === variantId)?.onHand;
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  owner = await signup('ABC Paints');
});

afterAll(async () => {
  expect(await findStockMismatches(t.connection.db)).toEqual([]);
  await t.close();
  await database.stop();
});

describe('a full count', () => {
  it('records the books, takes counts, shows variances and posts corrections on approval', async () => {
    const s = await setup();
    const manager = await hire('branch_manager', [s.store]);
    const other = await hire('inventory_manager', [s.store]);

    const started = await start(manager, { storeId: s.store, note: 'Month-end count' });
    expect(started.statusCode).toBe(201);
    const stockCount = started.json<Count>();
    expect(stockCount.number).toMatch(/^SC-\d{6}$/);
    const managerId = (await api(manager).get('/auth/me')).json<{ memberId: string }>().memberId;
    expect(stockCount.startedBy).toEqual({ memberId: managerId, name: 'Staff branch_manager' });
    expect(stockCount.submittedBy).toBeNull();
    expect(stockCount.lines.map((l) => [l.sku, l.expectedQuantity, l.countedQuantity])).toEqual([
      [s.apex.sku, 10, null],
      [s.royale.sku, 4, null],
      [s.silk.sku, 6, null],
    ]);

    // Scan the Apex barcode 8 times, type the rest, and find a product that wasn't listed.
    await counts(
      manager,
      stockCount.id,
      Array.from({ length: 8 }, () => ({ code: s.apex.barcode })),
    );
    const counted = (
      await counts(manager, stockCount.id, [
        { code: s.royale.sku.toLowerCase(), quantity: 4, mode: 'set' },
        { variantId: s.silk.id, quantity: 7, mode: 'set' },
        { variantId: s.spare.id, quantity: 2, mode: 'set' },
      ])
    ).json<Count>();
    expect(counted.lines.find((l) => l.sku === s.spare.sku)).toMatchObject({
      expectedQuantity: 0,
      countedQuantity: 2,
    });
    expect(counted.lines.find((l) => l.sku === s.apex.sku)).toMatchObject({
      countedQuantity: 8,
      variance: -2,
      varianceValuePaise: -20_000,
    });
    expect(counted.summary).toEqual({
      totalLines: 4,
      countedLines: 4,
      uncountedLines: 0,
      matchingLines: 1,
      accuracyPercent: 25,
      netVarianceValuePaise: -15_000,
      absoluteVarianceValuePaise: 25_000,
    });

    const submitted = (
      await api(manager).post(`/stock-counts/${stockCount.id}/submit`)
    ).json<Count>();
    expect(submitted.status).toBe('submitted');
    expect(submitted.submittedAt).not.toBeNull();
    expect(submitted.submittedBy).toEqual({ memberId: managerId, name: 'Staff branch_manager' });

    const approved = (
      await api(other).post(`/stock-counts/${stockCount.id}/approve`, {
        reasons: [{ variantId: s.apex.id, reason: 'theft' }],
      })
    ).json<Count>();
    expect(approved.status).toBe('approved');
    expect(approved.lines.find((l) => l.sku === s.apex.sku)?.reason).toBe('theft');

    expect(await stockOf(s.store, s.apex.id)).toBe(8);
    expect(await stockOf(s.store, s.royale.id)).toBe(4);
    expect(await stockOf(s.store, s.silk.id)).toBe(7);
    expect(await stockOf(s.store, s.spare.id)).toBe(2);
    const ledger = (
      await api(owner).get(`/stock/ledger?storeId=${s.store}&variantId=${s.apex.id}`)
    ).json<{
      items: { movementType: string; quantity: number; note: string }[];
    }>();
    expect(ledger.items[0]).toMatchObject({ movementType: 'count_correction', quantity: -2 });
    expect(ledger.items[0]?.note).toContain('theft');
  });

  it('keeps sales made during the count: corrections are added on top', async () => {
    const s = await setup();
    const { id } = (await start(owner, { storeId: s.store })).json<Count>();
    await counts(owner, id, [
      { variantId: s.apex.id, quantity: 9, mode: 'set' },
      { variantId: s.royale.id, quantity: 4, mode: 'set' },
      { variantId: s.silk.id, quantity: 6, mode: 'set' },
    ]);
    // Two cans leave after they were counted.
    await api(owner).post('/stock/movements', {
      storeId: s.store,
      type: 'damage',
      note: 'Broken after counting',
      lines: [{ variantId: s.apex.id, quantity: 2 }],
    });

    await api(owner).post(`/stock-counts/${id}/submit`);
    await api(owner).post(`/stock-counts/${id}/approve`);

    // Books said 10, counted 9 (−1), then 2 broke: 10 − 2 − 1 = 7.
    expect(await stockOf(s.store, s.apex.id)).toBe(7);
  });
});

describe('scope', () => {
  it('counts one brand only, refusing other brands', async () => {
    const s = await setup();

    const stockCount = (
      await start(owner, { storeId: s.store, scope: 'brand', scopeId: s.brandB })
    ).json<Count>();
    const outside = await counts(owner, stockCount.id, [{ variantId: s.apex.id, quantity: 1 }]);
    const outsideByCode = await counts(owner, stockCount.id, [{ code: s.apex.sku, quantity: 1 }]);

    expect(stockCount.lines.map((l) => l.sku)).toEqual([s.silk.sku]);
    expect(outside.statusCode).toBe(400);
    expect(outside.json<{ message: string }>().message).toBe(
      `${s.apex.id} is not part of this count`,
    );
    expect(outsideByCode.json<{ message: string }>().message).toBe(
      `${s.apex.sku} is not part of this count`,
    );
  });

  it('counts a category including its subcategories', async () => {
    const s = await setup();
    const categories = (await api(owner).get('/categories')).json<
      { id: string; parentId: string | null }[]
    >();
    const parent = categories.find((c) => c.id === s.category)?.parentId ?? '';

    const stockCount = (
      await start(owner, { storeId: s.store, scope: 'category', scopeId: parent })
    ).json<Count>();

    expect(stockCount.lines.map((l) => l.sku)).toEqual([s.apex.sku]);
  });

  it('refuses an unknown brand or category, and a scope id without a scope', async () => {
    const s = await setup();
    const ghost = '00000000-0000-4000-8000-000000000000';

    expect(
      (await start(owner, { storeId: s.store, scope: 'brand', scopeId: ghost })).statusCode,
    ).toBe(400);
    expect(
      (await start(owner, { storeId: s.store, scope: 'category', scopeId: ghost })).statusCode,
    ).toBe(400);
    expect((await start(owner, { storeId: s.store, scopeId: s.brandA })).statusCode).toBe(400);
    expect((await start(owner, { storeId: s.store, scope: 'brand' })).statusCode).toBe(400);
  });
});

describe('rules', () => {
  it('allows one open count per store', async () => {
    const s = await setup();
    await start(owner, { storeId: s.store });

    const second = await start(owner, { storeId: s.store });

    expect(second.statusCode).toBe(409);
  });

  it('starts an empty count at a store with no stock', async () => {
    const store = (await api(owner).post('/stores', { name: 'Empty', code: 'EMPTY1' })).json<{
      id: string;
    }>().id;

    const stockCount = (await start(owner, { storeId: store })).json<Count>();

    expect(stockCount.lines).toEqual([]);
    expect(stockCount.summary.accuracyPercent).toBeNull();
  });

  it('refuses submission while products are uncounted, unless they count as zero', async () => {
    const s = await setup();
    const { id } = (await start(owner, { storeId: s.store })).json<Count>();
    await counts(owner, id, [{ variantId: s.apex.id, quantity: 10, mode: 'set' }]);

    const refused = await api(owner).post(`/stock-counts/${id}/submit`);
    const asZero = (
      await api(owner).post(`/stock-counts/${id}/submit`, { uncountedAsZero: true })
    ).json<Count>();

    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ message: string }>().message).toContain(
      `2 product(s) not counted yet: ${s.royale.sku}, ${s.silk.sku}`,
    );
    expect(asZero.lines.find((l) => l.sku === s.silk.sku)).toMatchObject({
      countedQuantity: 0,
      variance: -6,
    });
  });

  it('lets a scan be undone, but never below zero', async () => {
    const s = await setup();
    const { id } = (await start(owner, { storeId: s.store })).json<Count>();
    await counts(owner, id, [{ code: s.apex.barcode }, { code: s.apex.barcode }]);

    const undone = (
      await counts(owner, id, [{ code: s.apex.barcode, quantity: -1 }])
    ).json<Count>();
    const tooFar = await counts(owner, id, [{ code: s.apex.barcode, quantity: -5 }]);

    expect(undone.lines.find((l) => l.sku === s.apex.sku)?.countedQuantity).toBe(1);
    expect(tooFar.statusCode).toBe(400);
    expect(tooFar.json<{ message: string }>().message).toBe(
      'A counted quantity cannot go below zero',
    );
  });

  it('refuses unknown products and badly formed entries', async () => {
    const s = await setup();
    const { id } = (await start(owner, { storeId: s.store })).json<Count>();

    const unknownCode = await counts(owner, id, [{ code: 'NO-SUCH-THING' }]);
    const unknownId = await counts(owner, id, [
      { variantId: '00000000-0000-4000-8000-000000000000', quantity: 1 },
    ]);
    const both = await counts(owner, id, [{ code: 'X', variantId: s.apex.id, quantity: 1 }]);
    const negativeSet = await counts(owner, id, [
      { variantId: s.apex.id, quantity: -1, mode: 'set' },
    ]);

    expect(unknownCode.json<{ message: string }>().message).toBe('Unknown product: NO-SUCH-THING');
    expect(unknownId.statusCode).toBe(400);
    expect(both.statusCode).toBe(400);
    expect(negativeSet.statusCode).toBe(400);
  });

  it('can be reopened for a recount, then submitted again', async () => {
    const s = await setup();
    const { id } = (await start(owner, { storeId: s.store })).json<Count>();
    await counts(owner, id, [
      { variantId: s.apex.id, quantity: 1, mode: 'set' },
      { variantId: s.royale.id, quantity: 4, mode: 'set' },
      { variantId: s.silk.id, quantity: 6, mode: 'set' },
    ]);
    await api(owner).post(`/stock-counts/${id}/submit`);

    const reopened = (await api(owner).post(`/stock-counts/${id}/reopen`)).json<Count>();
    await counts(owner, id, [{ variantId: s.apex.id, quantity: 10, mode: 'set' }]);
    const resubmitted = (await api(owner).post(`/stock-counts/${id}/submit`)).json<Count>();

    expect(reopened).toMatchObject({ status: 'counting', submittedAt: null, submittedBy: null });
    expect(resubmitted.summary.accuracyPercent).toBe(100);
  });

  it('can be cancelled without touching stock', async () => {
    const s = await setup();
    const { id } = (await start(owner, { storeId: s.store })).json<Count>();
    await counts(owner, id, [{ variantId: s.apex.id, quantity: 1, mode: 'set' }]);

    const cancelled = (
      await api(owner).post(`/stock-counts/${id}/cancel`, { reason: 'Wrong store' })
    ).json<Count>();

    expect(cancelled).toMatchObject({ status: 'cancelled', closingReason: 'Wrong store' });
    expect(await stockOf(s.store, s.apex.id)).toBe(10);
    expect((await counts(owner, id, [{ variantId: s.apex.id, quantity: 1 }])).statusCode).toBe(409);
    expect((await api(owner).post(`/stock-counts/${id}/cancel`, { reason: 'x' })).statusCode).toBe(
      400,
    );
  });

  it('only approves submitted counts, and a reason must name a product on the count', async () => {
    const s = await setup();
    const { id } = (await start(owner, { storeId: s.store })).json<Count>();

    expect((await api(owner).post(`/stock-counts/${id}/approve`)).statusCode).toBe(409);
    await api(owner).post(`/stock-counts/${id}/submit`, { uncountedAsZero: true });
    const badReason = await api(owner).post(`/stock-counts/${id}/approve`, {
      reasons: [{ variantId: s.spare.id, reason: 'expiry' }],
    });

    expect(badReason.statusCode).toBe(400);
  });

  it('refuses a correction that stock no longer covers', async () => {
    const s = await setup();
    const { id } = (await start(owner, { storeId: s.store })).json<Count>();
    await counts(owner, id, [
      { variantId: s.apex.id, quantity: 1, mode: 'set' },
      { variantId: s.royale.id, quantity: 4, mode: 'set' },
      { variantId: s.silk.id, quantity: 6, mode: 'set' },
    ]);
    await api(owner).post(`/stock-counts/${id}/submit`);
    // Most of the stock leaves before approval, so the −9 correction no longer fits.
    await api(owner).post('/stock/movements', {
      storeId: s.store,
      type: 'damage',
      note: 'Water damage',
      lines: [{ variantId: s.apex.id, quantity: 8 }],
    });

    const response = await api(owner).post(`/stock-counts/${id}/approve`);

    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toBe(
      `Stock of ${s.apex.sku} has fallen since the count started; reopen and recount it`,
    );
  });

  it('keeps the count submitted when approval fails unexpectedly', async () => {
    const s = await setup();
    const { id } = (await start(owner, { storeId: s.store })).json<Count>();
    await counts(owner, id, [
      { variantId: s.apex.id, quantity: 11, mode: 'set' },
      { variantId: s.royale.id, quantity: 4, mode: 'set' },
      { variantId: s.silk.id, quantity: 6, mode: 'set' },
    ]);
    await api(owner).post(`/stock-counts/${id}/submit`);
    const balance = and(
      eq(schema.stockBalances.storeId, s.store),
      eq(schema.stockBalances.variantId, s.apex.id),
    );
    // Push the balance to the column's limit so the +1 correction overflows it.
    await t.connection.db
      .update(schema.stockBalances)
      .set({ onHand: 99_999_999_999 })
      .where(balance);
    try {
      const response = await api(owner).post(`/stock-counts/${id}/approve`);

      expect(response.statusCode).toBe(500);
      expect((await api(owner).get(`/stock-counts/${id}`)).json<Count>().status).toBe('submitted');
    } finally {
      await t.connection.db.update(schema.stockBalances).set({ onHand: 10 }).where(balance);
    }
  });

  it('reports an unexpected database failure while counting as a server error', async () => {
    const s = await setup();
    const { id } = (await start(owner, { storeId: s.store })).json<Count>();
    const line = and(
      eq(schema.stockCountLines.countId, id),
      eq(schema.stockCountLines.variantId, s.apex.id),
    );
    await t.connection.db
      .update(schema.stockCountLines)
      .set({ countedQuantity: 99_999_999_999 })
      .where(line);

    const response = await counts(owner, id, [{ variantId: s.apex.id, quantity: 1 }]);

    expect(response.statusCode).toBe(500);
  });
});

describe('who can do what', () => {
  it('needs someone else to approve a count you submitted, unless you have all-store access', async () => {
    const s = await setup();
    const manager = await hire('branch_manager', [s.store]);
    const { id } = (await start(manager, { storeId: s.store })).json<Count>();
    await api(manager).post(`/stock-counts/${id}/submit`, { uncountedAsZero: true });

    const self = await api(manager).post(`/stock-counts/${id}/approve`);
    const byOwner = await api(owner).post(`/stock-counts/${id}/approve`);

    expect(self.statusCode).toBe(403);
    expect(self.json<{ message: string }>().message).toBe(
      'Someone else must approve a count you submitted',
    );
    expect(byOwner.statusCode).toBe(200);
  });

  it('lets owners approve their own counts', async () => {
    const s = await setup();
    const { id } = (await start(owner, { storeId: s.store })).json<Count>();
    await api(owner).post(`/stock-counts/${id}/submit`, { uncountedAsZero: true });

    expect((await api(owner).post(`/stock-counts/${id}/approve`)).statusCode).toBe(200);
  });

  it('keeps counts to the stores a member works at', async () => {
    const s = await setup();
    const elsewhere = await hire('branch_manager', [(await setup()).store]);
    const { id } = (await start(owner, { storeId: s.store })).json<Count>();

    expect((await start(elsewhere, { storeId: s.store })).statusCode).toBe(404);
    expect((await api(elsewhere).get(`/stock-counts/${id}`)).statusCode).toBe(404);
    expect((await counts(elsewhere, id, [{ variantId: s.apex.id, quantity: 1 }])).statusCode).toBe(
      404,
    );
    expect((await api(elsewhere).get(`/stock-counts?storeId=${s.store}`)).statusCode).toBe(404);
  });

  it('lets read-only staff view counts but not count', async () => {
    const s = await setup();
    const employee = await hire('store_employee', [s.store]);
    const { id } = (await start(owner, { storeId: s.store })).json<Count>();

    expect((await api(employee).get(`/stock-counts/${id}`)).statusCode).toBe(200);
    expect((await counts(employee, id, [{ variantId: s.apex.id, quantity: 1 }])).statusCode).toBe(
      403,
    );
  });
});

describe('races', () => {
  it('approves only once when two approvers click at the same moment', async () => {
    const s = await setup();
    hydManager = await hire('branch_manager', [s.store]);
    hydSecondManager = await hire('inventory_manager', [s.store]);
    const { id } = (await start(hydManager, { storeId: s.store })).json<Count>();
    await counts(hydManager, id, [
      { variantId: s.apex.id, quantity: 9, mode: 'set' },
      { variantId: s.royale.id, quantity: 4, mode: 'set' },
      { variantId: s.silk.id, quantity: 6, mode: 'set' },
    ]);
    await api(hydManager).post(`/stock-counts/${id}/submit`);

    // Hold the count row so both approvals queue on the status update (see transfers test).
    const blocker = new pg.Client({ connectionString: database.connectionString });
    await blocker.connect();
    let results: Awaited<ReturnType<ReturnType<typeof api>['post']>>[];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM stock_counts WHERE id = $1 FOR UPDATE', [id]);
      const racing = Promise.all([
        api(hydSecondManager).post(`/stock-counts/${id}/approve`),
        api(owner).post(`/stock-counts/${id}/approve`),
      ]);
      await vi.waitFor(
        async () => {
          const waiting = await withPgClient(database.connectionString, (client) =>
            client.query(
              `SELECT count(*)::int AS n FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock'`,
            ),
          );
          expect((waiting.rows[0] as { n: number }).n).toBe(2);
        },
        { timeout: 10_000, interval: 50 },
      );
      await blocker.query('ROLLBACK');
      results = await racing;
    } finally {
      await blocker.end();
    }

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json<{ message: string }>().message).toBe(
      'Someone else just changed this count; reload it',
    );
    expect(await stockOf(s.store, s.apex.id)).toBe(9);
  });
});

describe('lists and accuracy', () => {
  it('lists counts newest first, filtered by store and status', async () => {
    const s = await setup();
    const first = (await start(owner, { storeId: s.store })).json<Count>();
    await api(owner).post(`/stock-counts/${first.id}/cancel`, { reason: 'Restart' });
    const second = (await start(owner, { storeId: s.store })).json<Count>();

    const forStore = (await api(owner).get(`/stock-counts?storeId=${s.store}`)).json<{
      items: Count[];
      total: number;
    }>();
    const cancelled = (
      await api(owner).get(`/stock-counts?storeId=${s.store}&status=cancelled`)
    ).json<{ items: Count[] }>();
    const paged = (await api(owner).get('/stock-counts?limit=1')).json<{ items: Count[] }>();

    expect(forStore.items.map((c) => c.number)).toEqual([second.number, first.number]);
    expect(forStore.total).toBe(2);
    expect(cancelled.items.map((c) => c.id)).toEqual([first.id]);
    expect(paged.items).toHaveLength(1);
  });

  it("shows each store's accuracy at its last approved count", async () => {
    const token = await signup('Accuracy Paints');
    const counted = (await api(token).post('/stores', { name: 'Counted', code: 'CTD' })).json<{
      id: string;
    }>().id;
    await api(token).post('/stores', { name: 'Never Counted', code: 'NVR' });
    const brandId = (await api(token).post('/brands', { name: 'Acc Brand' })).json<{ id: string }>()
      .id;
    const variants = (
      await api(token).post('/products', {
        brandId,
        name: 'Acc',
        type: 'primer',
        hsnCode: '3209',
        variants: [
          { sku: 'ACC-1', packSize: 1, unit: 'l' },
          { sku: 'ACC-4', packSize: 4, unit: 'l' },
        ],
      })
    ).json<{ variants: { id: string }[] }>().variants;
    await api(token).post('/stock/movements', {
      storeId: counted,
      type: 'opening',
      lines: variants.map((v) => ({ variantId: v.id, quantity: 5 })),
    });
    const { id, number } = (
      await api(token).post('/stock-counts', { storeId: counted })
    ).json<Count>();
    await api(token).post(`/stock-counts/${id}/counts`, {
      entries: [
        { variantId: variants[0]?.id, quantity: 5, mode: 'set' },
        { variantId: variants[1]?.id, quantity: 4, mode: 'set' },
      ],
    });
    await api(token).post(`/stock-counts/${id}/submit`);
    await api(token).post(`/stock-counts/${id}/approve`);

    const accuracy = (await api(token).get('/stock-counts/accuracy')).json<
      {
        store: { code: string };
        lastCount: { number: string; accuracyPercent: number; countedLines: number } | null;
      }[]
    >();

    expect(accuracy).toEqual([
      {
        store: expect.objectContaining({ code: 'CTD' }),
        lastCount: { number, approvedAt: expect.any(String), accuracyPercent: 50, countedLines: 2 },
      },
      { store: expect.objectContaining({ code: 'NVR' }), lastCount: null },
    ]);
  });

  it('shows store staff only their stores, in lists and accuracy', async () => {
    const s = await setup();
    puneManager = await hire('branch_manager', [s.store]);
    await start(owner, { storeId: s.store });

    const list = (await api(puneManager).get('/stock-counts')).json<{ items: Count[] }>();
    const accuracy = (await api(puneManager).get('/stock-counts/accuracy')).json<
      { store: { id: string } }[]
    >();

    expect(list.items.every((c) => c.store.code === `CNT${String(seq)}`)).toBe(true);
    expect(accuracy.map((a) => a.store.id)).toEqual([s.store]);
  });

  it('answers 404 for an unknown count and 400 for a bad id or filter', async () => {
    expect(
      (await api(owner).get('/stock-counts/00000000-0000-4000-8000-000000000000')).statusCode,
    ).toBe(404);
    expect((await api(owner).get('/stock-counts/nope')).statusCode).toBe(400);
    expect((await api(owner).get('/stock-counts?status=done')).statusCode).toBe(400);
  });
});

describe('another business', () => {
  it("cannot see ABC Paints' counts", async () => {
    const rival = await signup('Rival Paints');

    expect((await api(rival).get('/stock-counts')).json<{ items: Count[] }>().items).toEqual([]);
  });
});
