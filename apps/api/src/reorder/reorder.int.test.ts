import { findStockMismatches, migrateDatabase, schema, sql } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

interface Item {
  store: { id: string; code: string };
  variant: { id: string; sku: string };
  product: { name: string };
  brand: { name: string };
}
interface Rule extends Item {
  minQuantity: number;
  reorderLevel: number;
  maxQuantity: number;
}
interface Low extends Rule {
  onHand: number;
  available: number;
  severity: string;
  suggestedQuantity: number;
}
interface Slow extends Item {
  onHand: number;
  lastDemandAt: string | null;
  daysIdle: number;
  valuePaise: number | null;
  productId: string;
  sellsAt: { store: { id: string; code: string; name: string }; soldQuantity: number } | null;
}
interface Suggestion extends Item {
  soldQuantity: number;
  dailyRate: number;
  leadTimeDays: number;
  supplierName: string | null;
  current: { minQuantity: number; reorderLevel: number; maxQuantity: number } | null;
  suggested: { minQuantity: number; reorderLevel: number; maxQuantity: number };
}
interface Page<T> {
  items: T[];
  total: number;
}

let database: TestDatabase;
let t: TestApp;
let owner: string;
let organizationId: string;
let seq = 0;

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  put: (url: string, payload: object) =>
    t.app.inject({ method: 'PUT', url, headers: bearer(token), payload }),
  post: (url: string, payload: object) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  delete: (url: string) => t.app.inject({ method: 'DELETE', url, headers: bearer(token) }),
});

async function signup(name: string) {
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
  return response.json<{ token: string; organizationId: string }>();
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

/** A store and a product with `variants` 1 L variants, each with its own SKU. */
async function setup(
  variants = 3,
): Promise<{ store: string; code: string; ids: string[]; skus: string[] }> {
  seq += 1;
  const code = `RO${String(seq)}`;
  const store = (await api(owner).post('/stores', { name: `Reorder ${String(seq)}`, code })).json<{
    id: string;
  }>().id;
  const brandId = (
    await api(owner).post('/brands', { name: `Reorder Brand ${String(seq)}` })
  ).json<{ id: string }>().id;
  const product = (
    await api(owner).post('/products', {
      brandId,
      name: `Reorder Product ${String(seq)}`,
      type: 'interior_paint',
      hsnCode: '3209',
      variants: Array.from({ length: variants }, (_, i) => ({
        sku: `RO${String(seq)}-${String(i + 1)}L`,
        packSize: i + 1,
        unit: 'l',
      })),
    })
  ).json<{ variants: { id: string; sku: string; packSize: number }[] }>();
  const ordered = [...product.variants].sort((a, b) => a.packSize - b.packSize);
  return { store, code, ids: ordered.map((v) => v.id), skus: ordered.map((v) => v.sku) };
}

const opening = (
  store: string,
  lines: { variantId: string; quantity: number; unitCostPaise?: number }[],
) => api(owner).post('/stock/movements', { storeId: store, type: 'opening', lines });

const rule = (
  storeId: string,
  variantId: string,
  minQuantity: number,
  reorderLevel: number,
  maxQuantity: number,
) => ({
  storeId,
  variantId,
  minQuantity,
  reorderLevel,
  maxQuantity,
});

/**
 * Writes ledger history dated in the past (the ledger is append-only, so this
 * inserts rather than rewrites) and keeps the balance in step with it.
 */
async function history(
  storeId: string,
  variantId: string,
  entries: {
    type: 'opening' | 'sale' | 'sale_return' | 'transfer_out' | 'damage';
    quantity: number;
    daysAgo: number;
    cost?: number;
  }[],
) {
  for (const entry of entries) {
    await t.connection.db.insert(schema.stockLedger).values({
      organizationId,
      storeId,
      variantId,
      movementType: entry.type,
      quantity: entry.quantity,
      unitCostPaise: entry.cost ?? null,
      createdAt: sql`now() - make_interval(days => ${entry.daysAgo})`,
    });
    // Same pattern as postStockMovements: ensure the row, then add to it.
    await t.connection.db
      .insert(schema.stockBalances)
      .values({ organizationId, storeId, variantId })
      .onConflictDoNothing();
    await t.connection.db
      .update(schema.stockBalances)
      .set({
        onHand: sql`${schema.stockBalances.onHand} + ${entry.quantity}`,
        avgCostPaise: sql`coalesce(${entry.cost ?? null}::bigint, ${schema.stockBalances.avgCostPaise})`,
      })
      .where(
        and(
          eq(schema.stockBalances.storeId, storeId),
          eq(schema.stockBalances.variantId, variantId),
        ),
      );
  }
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  ({ token: owner, organizationId } = await signup('ABC Paints'));
});

afterAll(async () => {
  expect(await findStockMismatches(t.connection.db)).toEqual([]);
  await t.close();
  await database.stop();
});

describe('reorder rules', () => {
  it('saves several rules at once, replaces them, lists and removes them', async () => {
    const { store, ids, skus } = await setup(2);

    const saved = await api(owner).put('/reorder-rules', {
      rules: [rule(store, ids[0] ?? '', 2, 5, 20), rule(store, ids[1] ?? '', 0, 3, 10)],
    });
    await api(owner).put('/reorder-rules', { rules: [rule(store, ids[0] ?? '', 4, 8, 30)] });
    const listed = (await api(owner).get(`/reorder-rules?storeId=${store}`)).json<Page<Rule>>();

    expect(saved.json()).toEqual({ saved: 2 });
    expect(
      listed.items.map((r) => [r.variant.sku, r.minQuantity, r.reorderLevel, r.maxQuantity]),
    ).toEqual([
      [skus[0], 4, 8, 30],
      [skus[1], 0, 3, 10],
    ]);

    expect((await api(owner).delete(`/reorder-rules/${store}/${ids[1] ?? ''}`)).statusCode).toBe(
      204,
    );
    expect((await api(owner).get(`/reorder-rules?storeId=${store}`)).json<Page<Rule>>().total).toBe(
      1,
    );
    expect((await api(owner).delete(`/reorder-rules/${store}/${ids[1] ?? ''}`)).statusCode).toBe(
      404,
    );
  });

  it('searches rules by SKU, product or brand, with paging', async () => {
    const { store, ids, skus } = await setup(3);
    await api(owner).put('/reorder-rules', { rules: ids.map((id) => rule(store, id, 1, 2, 5)) });

    const bySku = (await api(owner).get(`/reorder-rules?q=${skus[1] ?? ''}`)).json<Page<Rule>>();
    const paged = (await api(owner).get(`/reorder-rules?storeId=${store}&limit=2`)).json<
      Page<Rule>
    >();

    expect(bySku.items.map((r) => r.variant.sku)).toEqual([skus[1]]);
    expect(paged.items).toHaveLength(2);
    expect(paged.total).toBe(3);
  });

  it.each([
    [{ minQuantity: 6, reorderLevel: 5, maxQuantity: 10 }],
    [{ minQuantity: 1, reorderLevel: 11, maxQuantity: 10 }],
    [{ minQuantity: 0, reorderLevel: 0, maxQuantity: 0 }],
    [{ minQuantity: -1, reorderLevel: 2, maxQuantity: 3 }],
    [{ minQuantity: 1.2345, reorderLevel: 2, maxQuantity: 3 }],
  ])('refuses levels out of order: %o', async (levels) => {
    const { store, ids } = await setup(1);

    const response = await api(owner).put('/reorder-rules', {
      rules: [{ storeId: store, variantId: ids[0], ...levels }],
    });

    expect(response.statusCode).toBe(400);
  });

  it('has the database refuse levels out of order too', async () => {
    const { store, ids } = await setup(1);

    await expect(
      t.connection.db.insert(schema.reorderRules).values({
        organizationId,
        storeId: store,
        variantId: ids[0] ?? '',
        minQuantity: 5,
        reorderLevel: 2,
        maxQuantity: 10,
      }),
    ).rejects.toThrow();
  });

  it('refuses unknown products and stores the member cannot access', async () => {
    const { store, ids } = await setup(1);
    const other = await setup(1);
    const manager = await hire('branch_manager', [store]);
    const ghost = '00000000-0000-4000-8000-000000000000';

    expect(
      (await api(owner).put('/reorder-rules', { rules: [rule(store, ghost, 1, 2, 3)] })).statusCode,
    ).toBe(400);
    expect(
      (await api(owner).put('/reorder-rules', { rules: [rule(ghost, ids[0] ?? '', 1, 2, 3)] }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await api(manager).put('/reorder-rules', {
          rules: [rule(other.store, other.ids[0] ?? '', 1, 2, 3)],
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await api(manager).put('/reorder-rules', { rules: [rule(store, ids[0] ?? '', 1, 2, 3)] }))
        .statusCode,
    ).toBe(200);
    expect(
      (await api(manager).delete(`/reorder-rules/${other.store}/${other.ids[0] ?? ''}`)).statusCode,
    ).toBe(404);
    expect((await api(manager).get(`/reorder-rules?storeId=${other.store}`)).statusCode).toBe(404);
  });

  it('lets read-only staff view rules but not change them', async () => {
    const { store, ids } = await setup(1);
    const employee = await hire('store_employee', [store]);

    expect((await api(employee).get('/reorder-rules')).statusCode).toBe(200);
    expect(
      (await api(employee).put('/reorder-rules', { rules: [rule(store, ids[0] ?? '', 1, 2, 3)] }))
        .statusCode,
    ).toBe(403);
  });
});

describe('GET /stock/low', () => {
  it('lists products at or below their reorder level, most urgent first, with how much to order', async () => {
    const { store, ids, skus } = await setup(4);
    await opening(store, [
      { variantId: ids[0] ?? '', quantity: 1 },
      { variantId: ids[1] ?? '', quantity: 4 },
      { variantId: ids[2] ?? '', quantity: 50 },
    ]);
    await api(owner).put('/reorder-rules', {
      rules: [
        rule(store, ids[0] ?? '', 2, 5, 20), // 1 < min 2: below minimum
        rule(store, ids[1] ?? '', 2, 5, 12), // 4 ≤ reorder 5: reorder
        rule(store, ids[2] ?? '', 2, 5, 60), // 50: fine
        rule(store, ids[3] ?? '', 0, 3, 10), // never stocked: out of stock
      ],
    });

    const low = (await api(owner).get(`/stock/low?storeId=${store}`)).json<Page<Low>>();

    expect(
      low.items.map((i) => [i.variant.sku, i.severity, i.available, i.suggestedQuantity]),
    ).toEqual([
      [skus[3], 'out_of_stock', 0, 10],
      [skus[0], 'below_minimum', 1, 19],
      [skus[1], 'reorder', 4, 8],
    ]);
    expect(low.total).toBe(3);
  });

  it('leaves out inactive products', async () => {
    const { store, ids, skus } = await setup(1);
    await api(owner).put('/reorder-rules', { rules: [rule(store, ids[0] ?? '', 0, 3, 10)] });
    const productId = (await api(owner).get(`/products/lookup?code=${skus[0] ?? ''}`)).json<{
      product: { id: string };
    }>().product.id;

    await t.app.inject({
      method: 'PATCH',
      url: `/products/${productId}`,
      headers: bearer(owner),
      payload: { isActive: false },
    });

    expect((await api(owner).get(`/stock/low?storeId=${store}`)).json<Page<Low>>().items).toEqual(
      [],
    );
  });

  it("shows staff only their stores' low stock", async () => {
    const mine = await setup(1);
    const theirs = await setup(1);
    await api(owner).put('/reorder-rules', {
      rules: [
        rule(mine.store, mine.ids[0] ?? '', 0, 3, 10),
        rule(theirs.store, theirs.ids[0] ?? '', 0, 3, 10),
      ],
    });
    const manager = await hire('branch_manager', [mine.store]);

    const low = (await api(manager).get('/stock/low?limit=200')).json<Page<Low>>();

    expect(low.items.map((i) => i.store.code)).toEqual([mine.code]);
    expect((await api(manager).get(`/stock/low?storeId=${theirs.store}`)).statusCode).toBe(404);
  });
});

describe('GET /stock/slow-movers', () => {
  it('finds stock with no demand for N days, biggest money tied up first', async () => {
    const { store, ids, skus } = await setup(4);
    // Idle: bought 200 days ago, never sold.
    await history(store, ids[0] ?? '', [
      { type: 'opening', quantity: 10, daysAgo: 200, cost: 50_000 },
    ]);
    // Idle: last sold 120 days ago.
    await history(store, ids[1] ?? '', [
      { type: 'opening', quantity: 5, daysAgo: 300, cost: 10_000 },
      { type: 'sale', quantity: -1, daysAgo: 120 },
    ]);
    // Moving: sent to another store 10 days ago (damage does not count as demand).
    await history(store, ids[2] ?? '', [
      { type: 'opening', quantity: 5, daysAgo: 300, cost: 10_000 },
      { type: 'transfer_out', quantity: -1, daysAgo: 10 },
      { type: 'damage', quantity: -1, daysAgo: 1 },
    ]);
    // Idle but out of stock: not tying up money.
    await history(store, ids[3] ?? '', [
      { type: 'opening', quantity: 1, daysAgo: 400 },
      { type: 'sale', quantity: -1, daysAgo: 399 },
    ]);

    const slow = (await api(owner).get(`/stock/slow-movers?storeId=${store}&days=90`)).json<
      Page<Slow>
    >();

    expect(slow.items.map((i) => [i.variant.sku, i.onHand, i.daysIdle, i.valuePaise])).toEqual([
      [skus[0], 10, 200, 500_000],
      [skus[1], 4, 120, 40_000],
    ]);
    expect(slow.items[0]?.lastDemandAt).toBeNull();
    expect(slow.items[1]?.lastDemandAt).not.toBeNull();
    expect(slow.total).toBe(2);

    const stricter = (await api(owner).get(`/stock/slow-movers?storeId=${store}&days=150`)).json<
      Page<Slow>
    >();
    expect(stricter.items.map((i) => i.variant.sku)).toEqual([skus[0]]);
  });

  it('names the store where each one sells, over the same window', async () => {
    const { store, ids } = await setup(1);
    const variant = ids[0] ?? '';
    const another = async (code: string) =>
      (await api(owner).post('/stores', { name: `Branch ${code}`, code })).json<{ id: string }>()
        .id;
    seq += 1;
    const busy = await another(`SB${String(seq)}`);
    const quiet = await another(`SQ${String(seq)}`);
    const once = await another(`SO${String(seq)}`);
    await history(store, variant, [{ type: 'opening', quantity: 10, daysAgo: 200 }]);
    await history(busy, variant, [
      { type: 'opening', quantity: 20, daysAgo: 200 },
      { type: 'sale', quantity: -5, daysAgo: 10 },
      { type: 'sale', quantity: -2, daysAgo: 20 },
      { type: 'sale_return', quantity: 1, daysAgo: 5 },
    ]);
    await history(quiet, variant, [
      { type: 'opening', quantity: 5, daysAgo: 200 },
      { type: 'sale', quantity: -1, daysAgo: 5 },
    ]);
    // Sold a lot, but before the window.
    await history(once, variant, [
      { type: 'opening', quantity: 30, daysAgo: 300 },
      { type: 'sale', quantity: -20, daysAgo: 120 },
    ]);

    const slow = (await api(owner).get(`/stock/slow-movers?storeId=${store}&days=90`)).json<
      Page<Slow>
    >();

    expect(slow.items[0]?.sellsAt).toEqual({
      store: { id: busy, code: `SB${String(seq)}`, name: `Branch SB${String(seq)}` },
      soldQuantity: 6,
    });
    expect(slow.items[0]?.productId).toEqual(expect.any(String));
  });

  it('lists items without a cost after those with one', async () => {
    const { store, ids, skus } = await setup(2);
    await history(store, ids[0] ?? '', [{ type: 'opening', quantity: 3, daysAgo: 100 }]);
    await history(store, ids[1] ?? '', [{ type: 'opening', quantity: 1, daysAgo: 100, cost: 100 }]);

    const slow = (await api(owner).get(`/stock/slow-movers?storeId=${store}`)).json<Page<Slow>>();

    expect(slow.items.map((i) => [i.variant.sku, i.valuePaise])).toEqual([
      [skus[1], 100],
      [skus[0], null],
    ]);
  });

  it('defaults to 90 days, keeps staff to their stores, and validates the window', async () => {
    const { store, ids } = await setup(1);
    await history(store, ids[0] ?? '', [{ type: 'opening', quantity: 2, daysAgo: 91 }]);
    const manager = await hire('branch_manager', [store]);
    const other = await setup(1);

    expect(
      (await api(manager).get('/stock/slow-movers'))
        .json<Page<Slow>>()
        .items.map((i) => i.store.id),
    ).toEqual([store]);
    expect((await api(manager).get(`/stock/slow-movers?storeId=${other.store}`)).statusCode).toBe(
      404,
    );
    expect((await api(owner).get('/stock/slow-movers?days=0')).statusCode).toBe(400);
  });
});

describe('another business', () => {
  it('sees none of ABC Paints’ rules or alerts', async () => {
    const rival = (await signup('Rival Paints')).token;

    expect((await api(rival).get('/reorder-rules')).json<Page<Rule>>().items).toEqual([]);
    expect((await api(rival).get('/stock/low')).json<Page<Low>>().items).toEqual([]);
    expect((await api(rival).get('/stock/slow-movers?days=1')).json<Page<Slow>>().items).toEqual(
      [],
    );
  });
});

/** A supplier who delivers in `leadTimeDays` (null: none on record), last received `daysAgo`. */
async function supplier(
  name: string,
  leadTimeDays: number | null,
  supplies: { variantId: string; daysAgo: number | null }[],
) {
  const [party] = await t.connection.db
    .insert(schema.parties)
    .values({ organizationId, displayName: name, kind: 'organization' })
    .returning({ id: schema.parties.id });
  const partyId = String(party?.id);
  await t.connection.db
    .insert(schema.supplierProfiles)
    .values({ organizationId, partyId, leadTimeDays });
  for (const item of supplies) {
    await t.connection.db.insert(schema.supplierProducts).values({
      organizationId,
      supplierPartyId: partyId,
      variantId: item.variantId,
      lastReceivedAt:
        item.daysAgo === null ? null : sql`now() - make_interval(days => ${item.daysAgo})`,
    });
  }
}

describe('GET /reorder-rules/suggestions', () => {
  it('works levels out from net sales and the last supplier’s lead time, fastest first', async () => {
    const { store, ids, skus } = await setup(3);
    const [fast, slow, unsupplied] = ids as [string, string, string];
    // 90 sold, 0 returned in 90 days: one a day. Sales before the window do not count.
    await history(store, fast, [
      { type: 'opening', quantity: 200, daysAgo: 120 },
      { type: 'sale', quantity: -50, daysAgo: 100 },
      { type: 'sale', quantity: -95, daysAgo: 25 },
      { type: 'sale_return', quantity: 5, daysAgo: 20 },
      // Transfers and damage are not demand.
      { type: 'transfer_out', quantity: -10, daysAgo: 5 },
      { type: 'damage', quantity: -1, daysAgo: 2 },
    ]);
    await history(store, slow, [
      { type: 'opening', quantity: 10, daysAgo: 120 },
      { type: 'sale', quantity: -9, daysAgo: 10 },
    ]);
    await history(store, unsupplied, [
      { type: 'opening', quantity: 10, daysAgo: 120 },
      { type: 'sale', quantity: -2, daysAgo: 10 },
    ]);
    // The fast seller last came from the 5-day supplier; the older one takes 12 days.
    await supplier('Shah Distributors', 5, [{ variantId: fast, daysAgo: 3 }]);
    await supplier('Old Depot', 12, [
      { variantId: fast, daysAgo: 200 },
      { variantId: slow, daysAgo: null },
    ]);
    // Someone with no lead time on record supplies the third: the default 7 days applies.
    await supplier('No Lead Time Traders', null, [{ variantId: unsupplied, daysAgo: 1 }]);
    expect(
      (
        await api(owner).put('/reorder-rules', {
          rules: [
            { storeId: store, variantId: fast, minQuantity: 2, reorderLevel: 4, maxQuantity: 10 },
          ],
        })
      ).statusCode,
    ).toBe(200);

    const reply = await api(owner).get(`/reorder-rules/suggestions?storeId=${store}`);
    expect(reply.statusCode).toBe(200);
    const page = reply.json<Page<Suggestion>>();
    expect(page.total).toBe(3);
    expect(
      page.items.map((i) => [
        i.variant.sku,
        i.soldQuantity,
        i.dailyRate,
        i.leadTimeDays,
        i.supplierName,
        i.current,
        i.suggested,
      ]),
    ).toEqual([
      [
        skus[0],
        90,
        1,
        5,
        'Shah Distributors',
        { minQuantity: 2, reorderLevel: 4, maxQuantity: 10 },
        { minQuantity: 5, reorderLevel: 12, maxQuantity: 42 },
      ],
      [skus[1], 9, 0.1, 12, 'Old Depot', null, { minQuantity: 2, reorderLevel: 2, maxQuantity: 5 }],
      [skus[2], 2, 0.022, 7, null, null, { minQuantity: 1, reorderLevel: 1, maxQuantity: 2 }],
    ]);

    // A shorter window and more safety days; pages.
    const tighter = (
      await api(owner).get(
        `/reorder-rules/suggestions?storeId=${store}&days=30&safetyDays=0&limit=1&offset=1`,
      )
    ).json<Page<Suggestion>>();
    expect(tighter.total).toBe(3);
    expect(tighter.items.map((i) => [i.variant.sku, i.soldQuantity, i.suggested])).toEqual([
      [skus[1], 9, { minQuantity: 4, reorderLevel: 4, maxQuantity: 13 }],
    ]);
  });

  it('answers an empty page for a store that sold nothing', async () => {
    const { store } = await setup(1);
    expect(
      (await api(owner).get(`/reorder-rules/suggestions?storeId=${store}`)).json<
        Page<Suggestion>
      >(),
    ).toEqual({ items: [], total: 0 });
  });

  it('needs a store the member works at, and a sensible window', async () => {
    const { store } = await setup(1);
    const other = await setup(1);
    const manager = await hire('branch_manager', [store]);
    expect((await api(manager).get(`/reorder-rules/suggestions?storeId=${store}`)).statusCode).toBe(
      200,
    );
    expect(
      (await api(manager).get(`/reorder-rules/suggestions?storeId=${other.store}`)).statusCode,
    ).toBe(404);
    expect((await api(owner).get('/reorder-rules/suggestions')).statusCode).toBe(400);
    expect(
      (await api(owner).get(`/reorder-rules/suggestions?storeId=${store}&days=7`)).statusCode,
    ).toBe(400);
    expect(
      (await api(owner).get(`/reorder-rules/suggestions?storeId=${store}&safetyDays=61`))
        .statusCode,
    ).toBe(400);
  });
});
