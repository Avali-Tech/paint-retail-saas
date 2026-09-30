import { findStockMismatches, migrateDatabase, schema } from '@paint/db';
import { and, eq } from 'drizzle-orm';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

interface StockRow {
  store: { id: string; code: string };
  variant: { id: string; sku: string };
  product: { name: string };
  brand: { name: string };
  onHand: number;
  reserved: number;
  available: number;
  avgCostPaise: number | null;
  valuePaise: number | null;
}
interface Entry {
  movementType: string;
  quantity: number;
  unitCostPaise: number | null;
  note: string | null;
  store: { code: string };
  variant: { sku: string };
  createdBy: string | null;
}
interface Page<T> {
  items: T[];
  total: number;
}

let database: TestDatabase;
let t: TestApp;
let owner: string;
let hydManager: string;
let hydEmployee: string;
let hyd: string;
let pune: string;
let seq = 0;

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
});

async function signup(name: string): Promise<string> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: name,
      fullName: `${name} Owner`,
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

/** A new product with 1 L and 20 L variants; returns their ids. */
async function newProduct(
  token = owner,
): Promise<{ oneLitre: string; twentyLitre: string; sku: string }> {
  seq += 1;
  const sku = `INV-${String(seq)}`;
  const brandId = (await api(token).post('/brands', { name: `Stock Brand ${String(seq)}` })).json<{
    id: string;
  }>().id;
  const product = (
    await api(token).post('/products', {
      brandId,
      name: `Stock Product ${String(seq)}`,
      type: 'interior_paint',
      hsnCode: '3209',
      gstRatePercent: 18,
      variants: [
        { sku: `${sku}-1L`, packSize: 1, unit: 'l' },
        { sku: `${sku}-20L`, packSize: 20, unit: 'l' },
      ],
    })
  ).json<{ variants: { id: string; packSize: number }[] }>();
  const idOf = (size: number) =>
    product.variants.find((variant) => variant.packSize === size)?.id ?? '';
  return { oneLitre: idOf(1), twentyLitre: idOf(20), sku };
}

const move = (token: string, payload: object) => api(token).post('/stock/movements', payload);

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  owner = await signup('ABC Paints');
  hyd = (await api(owner).post('/stores', { name: 'Hyderabad', code: 'HYD' })).json<{
    id: string;
  }>().id;
  pune = (await api(owner).post('/stores', { name: 'Pune', code: 'PUN' })).json<{ id: string }>()
    .id;
  hydManager = await hire('branch_manager', [hyd]);
  hydEmployee = await hire('store_employee', [hyd]);
});

afterAll(async () => {
  // Everything done through the API must leave balances equal to the ledger.
  expect(await findStockMismatches(t.connection.db)).toEqual([]);
  await t.close();
  await database.stop();
});

describe('opening stock', () => {
  it('records several products at once, with costs and who did it', async () => {
    const { oneLitre, twentyLitre, sku } = await newProduct();

    const response = await move(owner, {
      storeId: hyd,
      type: 'opening',
      lines: [
        { variantId: twentyLitre, quantity: 12, unitCostPaise: 1_000_000 },
        { variantId: oneLitre, quantity: 30 },
      ],
    });

    expect(response.statusCode).toBe(201);
    const entries = response.json<Page<Entry>>().items;
    expect(entries.map((e) => [e.variant.sku, e.movementType, e.quantity])).toEqual([
      [`${sku}-1L`, 'opening', 30],
      [`${sku}-20L`, 'opening', 12],
    ]);
    expect(entries[0]?.createdBy).toBe('ABC Paints Owner');

    const stock = (await api(owner).get(`/stock?storeId=${hyd}&q=${sku}`)).json<Page<StockRow>>();
    expect(stock.items.find((row) => row.variant.id === twentyLitre)).toMatchObject({
      onHand: 12,
      reserved: 0,
      available: 12,
      avgCostPaise: 1_000_000,
      valuePaise: 12_000_000,
    });
    expect(stock.items.find((row) => row.variant.id === oneLitre)).toMatchObject({
      onHand: 30,
      avgCostPaise: null,
      valuePaise: null,
    });
  });

  it('can be recorded only once per store and product, but separately for each store', async () => {
    const { oneLitre, sku } = await newProduct();
    await move(owner, {
      storeId: hyd,
      type: 'opening',
      lines: [{ variantId: oneLitre, quantity: 5 }],
    });

    const again = await move(owner, {
      storeId: hyd,
      type: 'opening',
      lines: [{ variantId: oneLitre, quantity: 5 }],
    });
    const otherStore = await move(owner, {
      storeId: pune,
      type: 'opening',
      lines: [{ variantId: oneLitre, quantity: 5 }],
    });

    expect(again.statusCode).toBe(409);
    expect(again.json<{ message: string }>().message).toContain(`${sku}-1L`);
    expect(otherStore.statusCode).toBe(201);
  });
});

describe('adjustments and write-offs', () => {
  it('adds and removes stock with a reason, and writes off damaged stock', async () => {
    const { oneLitre } = await newProduct();
    await move(owner, {
      storeId: hyd,
      type: 'opening',
      lines: [{ variantId: oneLitre, quantity: 10 }],
    });

    await move(owner, {
      storeId: hyd,
      type: 'adjustment',
      note: 'Found in back room',
      lines: [{ variantId: oneLitre, quantity: 5 }],
    });
    await move(owner, {
      storeId: hyd,
      type: 'adjustment',
      note: 'Miscount',
      lines: [{ variantId: oneLitre, quantity: -3 }],
    });
    const damage = await move(owner, {
      storeId: hyd,
      type: 'damage',
      note: 'Dented cans',
      lines: [{ variantId: oneLitre, quantity: 2 }],
    });

    expect(damage.json<Page<Entry>>().items[0]).toMatchObject({
      movementType: 'damage',
      quantity: -2,
      note: 'Dented cans',
    });
    const [row] = (await api(owner).get(`/stock?storeId=${hyd}`))
      .json<Page<StockRow>>()
      .items.filter((item) => item.variant.id === oneLitre);
    expect(row?.onHand).toBe(10);
  });

  it('refuses to write off more than is in stock, and records nothing from that request', async () => {
    const { oneLitre, twentyLitre, sku } = await newProduct();
    await move(owner, {
      storeId: hyd,
      type: 'opening',
      lines: [
        { variantId: oneLitre, quantity: 5 },
        { variantId: twentyLitre, quantity: 1 },
      ],
    });

    const response = await move(owner, {
      storeId: hyd,
      type: 'damage',
      note: 'Flood',
      lines: [
        { variantId: oneLitre, quantity: 2 },
        { variantId: twentyLitre, quantity: 3 },
      ],
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toBe(
      `Not enough stock of ${sku}-20L at HYD`,
    );
    const stock = (await api(owner).get(`/stock?q=${sku}&storeId=${hyd}`)).json<Page<StockRow>>();
    expect(stock.items.map((row) => row.onHand).sort()).toEqual([1, 5]);
  });

  it('reports an unexpected database failure as a server error, not a stock problem', async () => {
    const { oneLitre } = await newProduct();
    await move(owner, {
      storeId: hyd,
      type: 'opening',
      lines: [{ variantId: oneLitre, quantity: 1 }],
    });
    const balance = and(
      eq(schema.stockBalances.storeId, hyd),
      eq(schema.stockBalances.variantId, oneLitre),
    );
    // Push the balance to the column's limit so one more unit overflows.
    await t.connection.db
      .update(schema.stockBalances)
      .set({ onHand: 99_999_999_999 })
      .where(balance);
    try {
      const response = await move(owner, {
        storeId: hyd,
        type: 'adjustment',
        note: 'Overflow test',
        lines: [{ variantId: oneLitre, quantity: 1 }],
      });

      expect(response.statusCode).toBe(500);
    } finally {
      await t.connection.db.update(schema.stockBalances).set({ onHand: 1 }).where(balance);
    }
  });

  it.each([
    [{ type: 'adjustment', lines: [{ quantity: 1 }] }, 'note'],
    [{ type: 'damage', lines: [{ quantity: 1 }] }, 'note'],
    [{ type: 'opening', lines: [{ quantity: 0 }] }, 'lines.0.quantity'],
    [{ type: 'opening', lines: [{ quantity: -4 }] }, 'lines.0.quantity'],
    [{ type: 'opening', lines: [{ quantity: 1.2345 }] }, 'lines.0.quantity'],
    [
      { type: 'damage', note: 'x y z', lines: [{ quantity: 1, unitCostPaise: 100 }] },
      'lines.0.unitCostPaise',
    ],
    [
      { type: 'adjustment', note: 'x y z', lines: [{ quantity: -1, unitCostPaise: 100 }] },
      'lines.0.unitCostPaise',
    ],
    [{ type: 'transfer_in', lines: [{ quantity: 1 }] }, 'type'],
    [{ type: 'opening', lines: [] }, 'lines'],
  ])('answers 400 for %o', async (body, field) => {
    const { oneLitre } = await newProduct();
    const lines = (body.lines as object[]).map((line) => ({ variantId: oneLitre, ...line }));

    const response = await move(owner, { storeId: hyd, ...body, lines });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ issues: { path: string }[] }>().issues.map((i) => i.path)).toContain(
      field,
    );
  });

  it('refuses the same product twice in one request', async () => {
    const { oneLitre } = await newProduct();

    const response = await move(owner, {
      storeId: hyd,
      type: 'opening',
      lines: [
        { variantId: oneLitre, quantity: 1 },
        { variantId: oneLitre, quantity: 2 },
      ],
    });

    expect(response.json<{ issues: { path: string }[] }>().issues.map((i) => i.path)).toContain(
      'lines.1.variantId',
    );
  });

  it("refuses unknown products, including another business's", async () => {
    const rival = await signup('Rival Paints');
    const rivalProduct = await newProduct(rival);

    for (const variantId of [rivalProduct.oneLitre, '00000000-0000-4000-8000-000000000000']) {
      const response = await move(owner, {
        storeId: hyd,
        type: 'opening',
        lines: [{ variantId, quantity: 1 }],
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ message: string }>().message).toBe('Unknown product variant');
    }
  });
});

describe('store access', () => {
  it('lets a Hyderabad manager move Hyderabad stock only', async () => {
    const { oneLitre } = await newProduct();

    const own = await move(hydManager, {
      storeId: hyd,
      type: 'opening',
      lines: [{ variantId: oneLitre, quantity: 3 }],
    });
    const other = await move(hydManager, {
      storeId: pune,
      type: 'opening',
      lines: [{ variantId: oneLitre, quantity: 3 }],
    });
    const unknown = await move(owner, {
      storeId: '00000000-0000-4000-8000-000000000000',
      type: 'opening',
      lines: [{ variantId: oneLitre, quantity: 3 }],
    });

    expect(own.statusCode).toBe(201);
    expect(other.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
  });

  it('lets store staff view but not move stock', async () => {
    const { oneLitre } = await newProduct();

    expect((await api(hydEmployee).get('/stock')).statusCode).toBe(200);
    expect(
      (
        await move(hydEmployee, {
          storeId: hyd,
          type: 'opening',
          lines: [{ variantId: oneLitre, quantity: 1 }],
        })
      ).statusCode,
    ).toBe(403);
  });

  it("shows Hyderabad staff only Hyderabad's stock and history", async () => {
    const { oneLitre, sku } = await newProduct();
    await move(owner, {
      storeId: pune,
      type: 'opening',
      lines: [{ variantId: oneLitre, quantity: 9 }],
    });
    await move(owner, {
      storeId: hyd,
      type: 'opening',
      lines: [{ variantId: oneLitre, quantity: 4 }],
    });

    const stock = (await api(hydManager).get(`/stock?q=${sku}`)).json<Page<StockRow>>();
    const ledger = (await api(hydManager).get(`/stock/ledger?variantId=${oneLitre}`)).json<
      Page<Entry>
    >();

    expect(stock.items.map((row) => row.store.code)).toEqual(['HYD']);
    expect(ledger.items.map((entry) => entry.store.code)).toEqual(['HYD']);
    expect((await api(hydManager).get(`/stock?storeId=${pune}`)).statusCode).toBe(404);
    expect((await api(hydManager).get(`/stock/ledger?storeId=${pune}`)).statusCode).toBe(404);
  });
});

describe('GET /stock', () => {
  it('filters by product and hides empty stock on request, with paging', async () => {
    const { oneLitre, twentyLitre, sku } = await newProduct();
    await move(owner, {
      storeId: hyd,
      type: 'opening',
      lines: [
        { variantId: oneLitre, quantity: 2 },
        { variantId: twentyLitre, quantity: 1 },
      ],
    });
    await move(owner, {
      storeId: hyd,
      type: 'damage',
      note: 'Broken',
      lines: [{ variantId: twentyLitre, quantity: 1 }],
    });
    const all = (await api(owner).get(`/stock?q=${sku}`)).json<Page<StockRow>>();
    const inStock = (await api(owner).get(`/stock?q=${sku}&inStockOnly=true`)).json<
      Page<StockRow>
    >();
    const paged = (await api(owner).get(`/stock?q=${sku}&limit=1`)).json<Page<StockRow>>();

    expect(all.total).toBe(2);
    expect(inStock.items.map((row) => row.variant.sku)).toEqual([`${sku}-1L`]);
    expect(paged.items).toHaveLength(1);
    expect(paged.total).toBe(2);
  });

  it('filters by product id', async () => {
    const { oneLitre } = await newProduct();
    await move(owner, {
      storeId: hyd,
      type: 'opening',
      lines: [{ variantId: oneLitre, quantity: 1 }],
    });
    const products = (await api(owner).get('/products?limit=200')).json<{
      items: { id: string; variants: { id: string }[] }[];
    }>();
    const id = products.items.find((p) => p.variants.some((v) => v.id === oneLitre))?.id ?? '';
    const rows = (await api(owner).get(`/stock?productId=${id}`)).json<Page<StockRow>>();

    expect(rows.items.map((row) => row.variant.id)).toEqual([oneLitre]);
  });

  it('answers 400 for bad filters', async () => {
    expect((await api(owner).get('/stock?limit=0')).statusCode).toBe(400);
    expect((await api(owner).get('/stock?inStockOnly=maybe')).statusCode).toBe(400);
  });
});

describe('GET /stock/availability', () => {
  it('shows a product in every store the member can access, including stores without it', async () => {
    const { twentyLitre } = await newProduct();
    await move(owner, {
      storeId: pune,
      type: 'opening',
      lines: [{ variantId: twentyLitre, quantity: 40 }],
    });

    const forOwner = (await api(owner).get(`/stock/availability?variantId=${twentyLitre}`)).json<
      { store: { code: string }; onHand: number; available: number }[]
    >();
    const forHyd = (await api(hydManager).get(`/stock/availability?variantId=${twentyLitre}`)).json<
      { store: { code: string } }[]
    >();

    expect(forOwner.map((row) => [row.store.code, row.onHand, row.available])).toEqual([
      ['HYD', 0, 0],
      ['PUN', 40, 40],
    ]);
    expect(forHyd.map((row) => row.store.code)).toEqual(['HYD']);
  });

  it('answers 404 for an unknown variant and 400 without one', async () => {
    expect(
      (await api(owner).get('/stock/availability?variantId=00000000-0000-4000-8000-000000000000'))
        .statusCode,
    ).toBe(404);
    expect((await api(owner).get('/stock/availability')).statusCode).toBe(400);
  });
});

describe('GET /stock/ledger', () => {
  it('lists movements newest first, with paging', async () => {
    const { oneLitre } = await newProduct();
    await move(owner, {
      storeId: hyd,
      type: 'opening',
      lines: [{ variantId: oneLitre, quantity: 10 }],
    });
    await move(owner, {
      storeId: hyd,
      type: 'adjustment',
      note: 'Recount',
      lines: [{ variantId: oneLitre, quantity: -1 }],
    });

    const page = (await api(owner).get(`/stock/ledger?variantId=${oneLitre}&storeId=${hyd}`)).json<
      Page<Entry>
    >();
    const first = (await api(owner).get(`/stock/ledger?variantId=${oneLitre}&limit=1`)).json<
      Page<Entry>
    >();

    expect(page.items.map((entry) => entry.movementType)).toEqual(['adjustment', 'opening']);
    expect(first.items).toHaveLength(1);
    expect(first.total).toBe(2);
  });
});

describe('another business', () => {
  it("cannot see ABC Paints' stock", async () => {
    const rival = await signup('Other Paints');

    expect((await api(rival).get('/stock')).json<Page<StockRow>>().items).toEqual([]);
    expect((await api(rival).get('/stock/ledger')).json<Page<Entry>>().items).toEqual([]);
  });
});

describe('without signing in', () => {
  it('answers 401', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/stock' })).statusCode).toBe(401);
  });
});
