import { findStockMismatches, migrateDatabase, schema } from '@paint/db';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import { asc, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

interface Supplier {
  id: string;
  name: string;
  paymentTermsDays: number;
  leadTimeDays: number | null;
  productCount: number;
  products: {
    variantId: string;
    sku: string;
    supplierSku: string | null;
    lastCostPaise: number | null;
    lastReceivedAt: string | null;
  }[];
}
interface OrderLine {
  variantId: string;
  sku: string;
  orderedQuantity: number;
  receivedQuantity: number;
  pendingQuantity: number;
  unitCostPaise: number | null;
  valuePaise: number | null;
}
interface Order {
  id: string;
  number: string;
  status: string;
  supplier: { id: string; name: string };
  store: { code: string };
  expectedDate: string | null;
  closingReason: string | null;
  closedAt: string | null;
  lines: OrderLine[];
  totalValuePaise: number;
  receipts: { number: string; supplierInvoiceNumber: string | null }[];
}
interface Receipt {
  id: string;
  number: string;
  store: { code: string };
  supplier: { id: string };
  purchaseOrder: { id: string; number: string } | null;
  supplierInvoiceNumber: string | null;
  supplierInvoiceDate: string | null;
  lines: {
    variantId: string;
    quantity: number;
    freeQuantity: number;
    unitCostPaise: number | null;
    valuePaise: number | null;
  }[];
  totalValuePaise: number;
}
interface StockRow {
  variant: { id: string };
  onHand: number;
  avgCostPaise: number | null;
}
type Response = Awaited<ReturnType<ReturnType<typeof api>['post']>>;

const ghost = '00000000-0000-4000-8000-000000000000';

let database: TestDatabase;
let t: TestApp;
let owner: string;
let buyer: string;
let viewer: string;
let cashier: string;
let hyd: string;
let pune: string;
let seq = 0;

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object = {}) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  put: (url: string, payload: object) =>
    t.app.inject({ method: 'PUT', url, headers: bearer(token), payload }),
  patch: (url: string, payload: object) =>
    t.app.inject({ method: 'PATCH', url, headers: bearer(token), payload }),
  delete: (url: string) => t.app.inject({ method: 'DELETE', url, headers: bearer(token) }),
});

const message = (response: Response) => response.json<{ message: string }>().message;
const issuePaths = (response: Response) =>
  response.json<{ issues: { path: string }[] }>().issues.map((issue) => issue.path);

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

async function newParty(name: string, roles: string[] = ['supplier']): Promise<string> {
  const response = await api(owner).post('/parties', {
    kind: 'organization',
    displayName: name,
    roles,
  });
  return response.json<{ id: string }>().id;
}

/** A new product with `count` variants; returns their ids in SKU order. */
async function newVariants(count = 2): Promise<string[]> {
  seq += 1;
  const brandId = (await api(owner).post('/brands', { name: `P Brand ${String(seq)}` })).json<{
    id: string;
  }>().id;
  const product = (
    await api(owner).post('/products', {
      brandId,
      name: `P Product ${String(seq)}`,
      type: 'interior_paint',
      hsnCode: '3209',
      gstRatePercent: 18,
      variants: Array.from({ length: count }, (_, i) => ({
        sku: `P${String(seq)}-${String.fromCharCode(65 + i)}`,
        packSize: i + 1,
        unit: 'l',
      })),
    })
  ).json<{ variants: { id: string; sku: string }[] }>();
  return [...product.variants].sort((a, b) => a.sku.localeCompare(b.sku)).map((v) => v.id);
}

const order = (body: object, token = buyer) => api(token).post('/purchase-orders', body);
const receive = (body: object, token = buyer) => api(token).post('/goods-receipts', body);

async function stockAt(store: string, variantId: string): Promise<StockRow | undefined> {
  const page = (await api(owner).get(`/stock?storeId=${store}&limit=200`)).json<{
    items: StockRow[];
  }>();
  return page.items.find((row) => row.variant.id === variantId);
}

async function supplierProduct(supplierId: string, variantId: string) {
  const supplier = (await api(owner).get(`/suppliers/${supplierId}`)).json<Supplier>();
  return supplier.products.find((product) => product.variantId === variantId);
}

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
  buyer = await hire('inventory_manager', [hyd]);
  viewer = await hire('branch_manager', [hyd]);
  cashier = await hire('store_employee', [hyd]);
});

afterAll(async () => {
  expect(await findStockMismatches(t.connection.db)).toEqual([]);
  await t.close();
  await database.stop();
});

describe('suppliers', () => {
  it('lists only parties with the supplier role, with search and paging', async () => {
    const berger = await newParty('Berger Distributors');
    await newParty('Berger Customer', ['customer']);
    await newParty('Nerolac Agency');

    const all = (await api(owner).get('/suppliers?limit=200')).json<{
      items: Supplier[];
      total: number;
    }>();
    const found = (await api(viewer).get('/suppliers?q=berger')).json<{
      items: Supplier[];
      total: number;
    }>();
    const second = (await api(owner).get('/suppliers?q=e&limit=1&offset=1')).json<{
      items: Supplier[];
      total: number;
    }>();

    expect(all.items.map((s) => s.name)).not.toContain('Berger Customer');
    expect(found).toEqual({
      items: [
        {
          id: berger,
          name: 'Berger Distributors',
          phone: null,
          gstin: null,
          paymentTermsDays: 0,
          leadTimeDays: null,
          productCount: 0,
        },
      ],
      total: 1,
    });
    expect(second.items).toHaveLength(1);
    expect(second.total).toBeGreaterThanOrEqual(2);
  });

  it('saves payment terms and lead time, and changes them later', async () => {
    const supplier = await newParty('Asian Paints Depot');

    const saved = await api(buyer).put(`/suppliers/${supplier}/profile`, {
      paymentTermsDays: 30,
      leadTimeDays: 3,
    });
    const changed = await api(buyer).put(`/suppliers/${supplier}/profile`, {
      paymentTermsDays: 45,
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json<Supplier>()).toMatchObject({ paymentTermsDays: 30, leadTimeDays: 3 });
    expect(changed.json<Supplier>()).toMatchObject({ paymentTermsDays: 45, leadTimeDays: null });
    const bad = await api(buyer).put(`/suppliers/${supplier}/profile`, { paymentTermsDays: 400 });
    expect(bad.statusCode).toBe(400);
    expect(issuePaths(bad)).toContain('paymentTermsDays');
  });

  it('links products with the supplier’s own codes, updates and removes them', async () => {
    const supplier = await newParty('Indigo Depot');
    const [a, b] = await newVariants();

    const linked = (
      await api(buyer).put(`/suppliers/${supplier}/products`, {
        products: [{ variantId: a, supplierSku: 'IND-001' }, { variantId: b }],
      })
    ).json<Supplier>();
    const renamed = (
      await api(buyer).put(`/suppliers/${supplier}/products`, {
        products: [{ variantId: b, supplierSku: 'IND-002' }],
      })
    ).json<Supplier>();
    const removed = await api(buyer).delete(`/suppliers/${supplier}/products/${String(a)}`);
    const again = await api(buyer).delete(`/suppliers/${supplier}/products/${String(a)}`);

    expect(linked.productCount).toBe(2);
    expect(linked.products.map((p) => [p.supplierSku, p.lastCostPaise, p.lastReceivedAt])).toEqual([
      ['IND-001', null, null],
      [null, null, null],
    ]);
    expect(renamed.products.map((p) => p.supplierSku)).toEqual(['IND-001', 'IND-002']);
    expect(removed.statusCode).toBe(204);
    expect(again.statusCode).toBe(404);
    expect(message(again)).toBe('This supplier does not list that product');
    expect((await api(owner).get(`/suppliers/${supplier}`)).json<Supplier>().productCount).toBe(1);
  });

  it('refuses unknown products and duplicate lines', async () => {
    const supplier = await newParty('Dulux Depot');
    const [a] = await newVariants(1);

    const unknown = await api(buyer).put(`/suppliers/${supplier}/products`, {
      products: [{ variantId: ghost }],
    });
    const twice = await api(buyer).put(`/suppliers/${supplier}/products`, {
      products: [{ variantId: a }, { variantId: a }],
    });

    expect(unknown.statusCode).toBe(400);
    expect(message(unknown)).toBe('Unknown product variant');
    expect(issuePaths(twice)).toContain('products.1.variantId');
  });

  it('answers 404 for parties that are not active suppliers', async () => {
    const customer = await newParty('Just A Customer', ['customer']);
    const retired = await newParty('Retired Supplier');
    await api(owner).patch(`/parties/${retired}`, { isActive: false });
    const [a] = await newVariants(1);

    const responses = await Promise.all([
      api(owner).get(`/suppliers/${customer}`),
      api(owner).get(`/suppliers/${retired}`),
      api(owner).put(`/suppliers/${customer}/profile`, { paymentTermsDays: 0 }),
      api(owner).put(`/suppliers/${customer}/products`, { products: [{ variantId: a }] }),
      api(owner).delete(`/suppliers/${customer}/products/${String(a)}`),
    ]);

    expect(responses.map((r) => r.statusCode)).toEqual([404, 404, 404, 404, 404]);
    expect(message(responses[0])).toBe('Supplier not found');
    const listed = (await api(owner).get('/suppliers?q=Retired')).json<{ total: number }>();
    expect(listed.total).toBe(0);
  });

  it('needs purchasing permissions', async () => {
    const supplier = await newParty('Permission Depot');

    expect((await api(cashier).get('/suppliers')).statusCode).toBe(403);
    expect((await api(viewer).get(`/suppliers/${supplier}`)).statusCode).toBe(200);
    expect(
      (await api(viewer).put(`/suppliers/${supplier}/profile`, { paymentTermsDays: 1 })).statusCode,
    ).toBe(403);
  });
});

describe('purchase orders', () => {
  it('prices lines from the request, else the supplier’s last cost, else leaves them open', async () => {
    const supplier = await newParty('Pricing Depot');
    const [a, b, c] = await newVariants(3);
    // A direct receipt teaches the supplier's price for B.
    await receive({
      storeId: hyd,
      supplierId: supplier,
      supplierInvoiceNumber: 'PD-1',
      lines: [{ variantId: b, quantity: 1, unitCostPaise: 45_000 }],
    });

    const response = await order({
      supplierId: supplier,
      storeId: hyd,
      expectedDate: '2026-10-15',
      note: 'Diwali stock',
      lines: [
        { variantId: a, quantity: 10, unitCostPaise: 12_000 },
        { variantId: b, quantity: 2.5 },
        { variantId: c, quantity: 4 },
      ],
    });

    expect(response.statusCode).toBe(201);
    const created = response.json<Order>();
    expect(created).toMatchObject({
      status: 'open',
      supplier: { id: supplier, name: 'Pricing Depot' },
      store: { code: 'HYD' },
      expectedDate: '2026-10-15',
      closedAt: null,
      receipts: [],
      totalValuePaise: 120_000 + 112_500,
    });
    expect(created.number).toMatch(/^PO-\d{6}$/);
    expect(created.lines.map((l) => [l.orderedQuantity, l.unitCostPaise, l.valuePaise])).toEqual([
      [10, 12_000, 120_000],
      [2.5, 45_000, 112_500],
      [4, null, null],
    ]);
    expect(created.lines[0]).toMatchObject({ receivedQuantity: 0, pendingQuantity: 10 });
  });

  it('refuses unknown suppliers, stores and products, and stores the member does not work at', async () => {
    const supplier = await newParty('Refusals Depot');
    const customer = await newParty('Refusals Customer', ['customer']);
    const [a] = await newVariants(1);
    const body = { supplierId: supplier, storeId: hyd, lines: [{ variantId: a, quantity: 1 }] };

    const responses = await Promise.all([
      order({ ...body, supplierId: customer }),
      order({ ...body, storeId: ghost }),
      order({ ...body, storeId: pune }),
      order({ ...body, lines: [{ variantId: ghost, quantity: 1 }] }),
    ]);

    expect(responses.map((r) => [r.statusCode, message(r)])).toEqual([
      [404, 'Supplier not found'],
      [404, 'Store not found'],
      [404, 'Store not found'],
      [400, 'Unknown product variant'],
    ]);
  });

  it.each([
    [{ lines: [] }, 'lines'],
    [{ lines: [{ quantity: 0 }] }, 'lines.0.quantity'],
    [{ lines: [{ quantity: 1.0001 }] }, 'lines.0.quantity'],
    [{ lines: [{ quantity: 1 }, { quantity: 1 }] }, 'lines.1.variantId'],
    [{ lines: [{ quantity: 1, unitCostPaise: 10.5 }] }, 'lines.0.unitCostPaise'],
    [{ expectedDate: '15/10/2026' }, 'expectedDate'],
  ])('answers 400 for %o', async (overrides, field) => {
    const [a] = await newVariants(1);
    const body = { supplierId: ghost, storeId: hyd, lines: [{ quantity: 1 }], ...overrides };

    const response = await order({
      ...body,
      lines: body.lines.map((line) => ({ variantId: a, ...line })),
    });

    expect(response.statusCode).toBe(400);
    expect(issuePaths(response)).toContain(field);
  });

  describe('the quick reorder from low stock', () => {
    let supplier: string;
    let low: string;
    let costed: string;
    let empty: string;
    let healthy: string;
    let elsewhere: string;

    beforeAll(async () => {
      supplier = await newParty('Reorder Depot');
      const ids = await newVariants(5);
      [low, costed, empty, healthy, elsewhere] = [0, 1, 2, 3, 4].map((i) => String(ids[i])) as [
        string,
        string,
        string,
        string,
        string,
      ];
      // The supplier provides the first four; `elsewhere` comes from someone else.
      await api(owner).put(`/suppliers/${supplier}/products`, {
        products: ids.slice(0, 4).map((variantId) => ({ variantId })),
      });
      // Learns ₹80 for `low` from a receipt of 3 units (which also stocks it).
      await receive({
        storeId: hyd,
        supplierId: supplier,
        supplierInvoiceNumber: 'RD-1',
        lines: [{ variantId: low, quantity: 3, unitCostPaise: 8_000 }],
      });
      await api(owner).post('/stock/movements', {
        storeId: hyd,
        type: 'opening',
        lines: [
          { variantId: costed, quantity: 1, unitCostPaise: 5_000 },
          { variantId: healthy, quantity: 15 },
          { variantId: elsewhere, quantity: 1 },
        ],
      });
      await api(owner).put('/reorder-rules', {
        rules: ids.map((variantId) => ({
          storeId: hyd,
          variantId,
          minQuantity: 2,
          reorderLevel: 5,
          maxQuantity: 20,
        })),
      });
    });

    it('orders every low product the supplier provides up to its maximum', async () => {
      const response = await api(buyer).post('/purchase-orders/from-low-stock', {
        supplierId: supplier,
        storeId: hyd,
        note: 'Weekly reorder',
      });

      expect(response.statusCode).toBe(201);
      const created = response.json<Order>();
      expect(created.lines.map((l) => [l.variantId, l.orderedQuantity, l.unitCostPaise])).toEqual([
        [low, 17, 8_000],
        [costed, 19, 5_000],
        [empty, 20, null],
      ]);
    });

    it('can order chosen low products, even ones not yet linked to the supplier', async () => {
      const response = await api(buyer).post('/purchase-orders/from-low-stock', {
        supplierId: supplier,
        storeId: hyd,
        variantIds: [elsewhere, healthy],
      });

      expect(response.json<Order>().lines.map((l) => [l.variantId, l.orderedQuantity])).toEqual([
        [elsewhere, 19],
      ]);
    });

    it('answers 400 when nothing is low, and 404 for stores the member does not work at', async () => {
      const healthyOnly = await api(buyer).post('/purchase-orders/from-low-stock', {
        supplierId: supplier,
        storeId: hyd,
        variantIds: [healthy],
      });
      const otherStore = await api(buyer).post('/purchase-orders/from-low-stock', {
        supplierId: supplier,
        storeId: pune,
      });
      const twice = await api(buyer).post('/purchase-orders/from-low-stock', {
        supplierId: supplier,
        storeId: hyd,
        variantIds: [low, low],
      });

      expect(healthyOnly.statusCode).toBe(400);
      expect(message(healthyOnly)).toBe(
        'Nothing at this store needs reordering from this supplier',
      );
      expect(otherStore.statusCode).toBe(404);
      expect(issuePaths(twice)).toContain('variantIds');
    });
  });

  it('lists orders by status, supplier and store, only for the member’s stores', async () => {
    const supplier = await newParty('Listing Depot');
    const [a] = await newVariants(1);
    const body = {
      supplierId: supplier,
      lines: [{ variantId: a, quantity: 2, unitCostPaise: 500 }],
    };
    const atHyd = (await order({ ...body, storeId: hyd })).json<Order>();
    const atPune = (await order({ ...body, storeId: pune }, owner)).json<Order>();
    await api(owner).post(`/purchase-orders/${atPune.id}/cancel`, { reason: 'Not needed' });

    const mine = (await api(viewer).get(`/purchase-orders?supplierId=${supplier}`)).json<{
      items: { number: string; lineCount: number; totalValuePaise: number }[];
      total: number;
    }>();
    const everything = (await api(owner).get(`/purchase-orders?supplierId=${supplier}`)).json<{
      total: number;
    }>();
    const cancelled = (
      await api(owner).get(
        `/purchase-orders?supplierId=${supplier}&status=cancelled&storeId=${pune}`,
      )
    ).json<{ items: { number: string }[] }>();
    const forbidden = await api(viewer).get(`/purchase-orders?storeId=${pune}`);

    expect(mine).toEqual({
      items: [
        expect.objectContaining({ number: atHyd.number, lineCount: 1, totalValuePaise: 1_000 }),
      ],
      total: 1,
    });
    expect(everything.total).toBe(2);
    const anySupplier = (await api(owner).get('/purchase-orders?status=cancelled&limit=200')).json<{
      items: { number: string }[];
    }>();
    expect(anySupplier.items.map((o) => o.number)).toContain(atPune.number);
    expect(cancelled.items.map((o) => o.number)).toEqual([atPune.number]);
    expect(forbidden.statusCode).toBe(404);
    expect((await api(viewer).get(`/purchase-orders/${atPune.id}`)).statusCode).toBe(404);
    expect((await api(viewer).get(`/purchase-orders/${ghost}`)).statusCode).toBe(404);
    expect((await api(viewer).get(`/purchase-orders/${atHyd.id}`)).statusCode).toBe(200);
  });

  it('cancels an order before anything arrives, and short-closes one that partly arrived', async () => {
    const supplier = await newParty('Closing Depot');
    const [a] = await newVariants(1);
    const body = { supplierId: supplier, storeId: hyd, lines: [{ variantId: a, quantity: 5 }] };
    const first = (await order(body)).json<Order>();
    const second = (await order(body)).json<Order>();
    await receive({ purchaseOrderId: second.id, lines: [{ variantId: a, quantity: 2 }] });

    const closeOpen = await api(buyer).post(`/purchase-orders/${first.id}/close`, {
      reason: 'Short',
    });
    const cancelled = await api(buyer).post(`/purchase-orders/${first.id}/cancel`, {
      reason: 'Ordered by mistake',
    });
    const cancelAgain = await api(buyer).post(`/purchase-orders/${first.id}/cancel`, {
      reason: 'Again',
    });
    const cancelPartial = await api(buyer).post(`/purchase-orders/${second.id}/cancel`, {
      reason: 'Too late',
    });
    const closed = await api(buyer).post(`/purchase-orders/${second.id}/close`, {
      reason: 'Brand out of stock',
    });
    const receiveClosed = await receive({
      purchaseOrderId: second.id,
      lines: [{ variantId: a, quantity: 1 }],
    });

    expect([closeOpen.statusCode, message(closeOpen)]).toEqual([
      409,
      'This purchase order is open',
    ]);
    expect(cancelled.json<Order>()).toMatchObject({
      status: 'cancelled',
      closingReason: 'Ordered by mistake',
      closedAt: expect.any(String),
    });
    expect(message(cancelAgain)).toBe('This purchase order is cancelled');
    expect([cancelPartial.statusCode, message(cancelPartial)]).toEqual([
      409,
      'Goods have already arrived against this order; close it instead',
    ]);
    expect(closed.json<Order>()).toMatchObject({
      status: 'closed',
      closingReason: 'Brand out of stock',
    });
    expect([receiveClosed.statusCode, message(receiveClosed)]).toEqual([
      409,
      `${second.number} is closed`,
    ]);
    expect(
      (await api(buyer).post(`/purchase-orders/${first.id}/cancel`, { reason: 'x' })).statusCode,
    ).toBe(400);
    expect(
      (await api(viewer).post(`/purchase-orders/${first.id}/cancel`, { reason: 'Viewer' }))
        .statusCode,
    ).toBe(403);
  });

  it('cancels only once when two people click at the same moment', async () => {
    const supplier = await newParty('Race Depot');
    const [a] = await newVariants(1);
    const { id } = (
      await order({ supplierId: supplier, storeId: hyd, lines: [{ variantId: a, quantity: 1 }] })
    ).json<Order>();

    const results = await whileLocked('purchase_orders', id, () =>
      Promise.all([
        api(buyer).post(`/purchase-orders/${id}/cancel`, { reason: 'First click' }),
        api(owner).post(`/purchase-orders/${id}/cancel`, { reason: 'Second click' }),
      ]),
    );

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json<{ message: string }>().message).toBe(
      'Someone else just changed this purchase order; reload it',
    );
  });
});

describe('goods receipts', () => {
  it('receives an order in two deliveries, with free scheme units at zero cost', async () => {
    const supplier = await newParty('Journey Depot');
    const [a, b] = await newVariants();
    const po = (
      await order({
        supplierId: supplier,
        storeId: hyd,
        lines: [
          { variantId: a, quantity: 10, unitCostPaise: 9_000 },
          { variantId: b, quantity: 5 },
        ],
      })
    ).json<Order>();

    const first = await receive({
      purchaseOrderId: po.id,
      supplierInvoiceNumber: 'JD/24-25/101',
      supplierInvoiceDate: '2026-10-01',
      lines: [
        { variantId: a, quantity: 6, freeQuantity: 1 },
        { variantId: b, quantity: 5, unitCostPaise: 2_000 },
      ],
    });

    expect(first.statusCode).toBe(201);
    const grn = first.json<Receipt>();
    expect(grn).toMatchObject({
      store: { code: 'HYD' },
      supplier: { id: supplier },
      purchaseOrder: { id: po.id, number: po.number },
      supplierInvoiceNumber: 'JD/24-25/101',
      supplierInvoiceDate: '2026-10-01',
      totalValuePaise: 54_000 + 10_000,
    });
    expect(grn.number).toMatch(/^GRN-\d{6}$/);
    expect(
      grn.lines.map((l) => [l.quantity, l.freeQuantity, l.unitCostPaise, l.valuePaise]),
    ).toEqual([
      [6, 1, 9_000, 54_000],
      [5, 0, 2_000, 10_000],
    ]);
    // 6 paid at ₹90 + 1 free at ₹0 → 7 units averaging ₹77.14.
    expect(await stockAt(hyd, String(a))).toMatchObject({ onHand: 7, avgCostPaise: 7_714 });
    const ledger = await t.connection.db
      .select({
        quantity: schema.stockLedger.quantity,
        cost: schema.stockLedger.unitCostPaise,
        note: schema.stockLedger.note,
      })
      .from(schema.stockLedger)
      .where(eq(schema.stockLedger.referenceId, grn.id))
      .orderBy(asc(schema.stockLedger.quantity));
    expect(ledger).toEqual([
      { quantity: 1, cost: 0, note: `${grn.number} free (scheme)` },
      { quantity: 5, cost: 2_000, note: grn.number },
      { quantity: 6, cost: 9_000, note: grn.number },
    ]);
    const partly = (await api(viewer).get(`/purchase-orders/${po.id}`)).json<Order>();
    expect(partly.status).toBe('partially_received');
    expect(partly.lines.map((l) => [l.receivedQuantity, l.pendingQuantity])).toEqual([
      [6, 4],
      [5, 0],
    ]);
    expect(await supplierProduct(supplier, String(b))).toMatchObject({
      lastCostPaise: 2_000,
      lastReceivedAt: expect.any(String),
    });

    const second = await receive({
      purchaseOrderId: po.id,
      lines: [{ variantId: a, quantity: 4 }],
    });
    const done = (await api(viewer).get(`/purchase-orders/${po.id}`)).json<Order>();
    const third = await receive({ purchaseOrderId: po.id, lines: [{ variantId: a, quantity: 1 }] });

    expect(second.statusCode).toBe(201);
    expect(done.status).toBe('received');
    expect(done.receipts.map((r) => [r.number, r.supplierInvoiceNumber])).toEqual([
      [grn.number, 'JD/24-25/101'],
      [second.json<Receipt>().number, null],
    ]);
    expect(message(third)).toBe(`${po.number} is received`);
  });

  it('refuses more than is still due, and products not on the order', async () => {
    const supplier = await newParty('Over Depot');
    const [a, b] = await newVariants();
    const po = (
      await order({ supplierId: supplier, storeId: hyd, lines: [{ variantId: a, quantity: 4 }] })
    ).json<Order>();

    const responses = await Promise.all([
      receive({ purchaseOrderId: po.id, lines: [{ variantId: a, quantity: 4.5 }] }),
      receive({ purchaseOrderId: po.id, lines: [{ variantId: b, quantity: 1 }] }),
      receive({ purchaseOrderId: po.id, lines: [{ variantId: ghost, quantity: 1 }] }),
    ]);
    // Free units are not counted against the order.
    const withFree = await receive({
      purchaseOrderId: po.id,
      lines: [{ variantId: a, quantity: 4, freeQuantity: 2 }],
    });

    expect(responses.map((r) => [r.statusCode, message(r)])).toEqual([
      [400, `More P${String(seq)}-A than is still due on ${po.number} (4)`],
      [400, `P${String(seq)}-B is not on ${po.number}`],
      [400, 'Unknown product variant'],
    ]);
    expect(withFree.statusCode).toBe(201);
    expect((await stockAt(hyd, String(a)))?.onHand).toBe(6);
  });

  it('receives against a supplier invoice without an order, once per invoice', async () => {
    const supplier = await newParty('Invoice Depot');
    const otherSupplier = await newParty('Other Invoice Depot');
    const [a, b] = await newVariants();

    const first = await receive({
      storeId: hyd,
      supplierId: supplier,
      supplierInvoiceNumber: 'INV-501',
      note: 'Counter delivery',
      lines: [
        { variantId: a, quantity: 2, unitCostPaise: 30_000 },
        { variantId: b, quantity: 1 },
      ],
    });
    const repeat = await receive({
      storeId: hyd,
      supplierId: supplier,
      supplierInvoiceNumber: 'inv-501',
      lines: [{ variantId: a, quantity: 1 }],
    });
    const sameNumberOtherSupplier = await receive({
      storeId: hyd,
      supplierId: otherSupplier,
      supplierInvoiceNumber: 'INV-501',
      lines: [{ variantId: a, quantity: 1 }],
    });
    // No cost given: the supplier's last cost; free-only lines keep it.
    const later = await receive({
      storeId: hyd,
      supplierId: supplier,
      supplierInvoiceNumber: 'INV-502',
      lines: [
        { variantId: a, quantity: 1 },
        { variantId: b, quantity: 0, freeQuantity: 2 },
      ],
    });

    expect(first.statusCode).toBe(201);
    expect(first.json<Receipt>()).toMatchObject({ purchaseOrder: null, totalValuePaise: 60_000 });
    expect(first.json<Receipt>().lines.map((l) => l.unitCostPaise)).toEqual([30_000, null]);
    expect([repeat.statusCode, message(repeat)]).toEqual([
      409,
      'Invoice inv-501 from this supplier is already entered',
    ]);
    expect(sameNumberOtherSupplier.statusCode).toBe(201);
    expect(sameNumberOtherSupplier.json<Receipt>().lines[0]?.unitCostPaise).toBeNull();
    expect(later.json<Receipt>().lines.map((l) => [l.unitCostPaise, l.valuePaise])).toEqual([
      [30_000, 30_000],
      [null, null],
    ]);
    expect(await supplierProduct(supplier, String(a))).toMatchObject({ lastCostPaise: 30_000 });
    expect(await supplierProduct(supplier, String(b))).toMatchObject({
      lastCostPaise: null,
      lastReceivedAt: expect.any(String),
    });
  });

  it.each([
    [{ purchaseOrderId: ghost, storeId: ghost }, 'storeId'],
    [{ purchaseOrderId: ghost, supplierId: ghost }, 'supplierId'],
    [{ supplierId: ghost, supplierInvoiceNumber: 'X1' }, 'storeId'],
    [{ storeId: ghost, supplierInvoiceNumber: 'X1' }, 'supplierId'],
    [{ storeId: ghost, supplierId: ghost }, 'supplierInvoiceNumber'],
    [{ purchaseOrderId: ghost, supplierInvoiceDate: '2026-10-01' }, 'supplierInvoiceNumber'],
    [{ purchaseOrderId: ghost, lines: [{ quantity: 0, freeQuantity: 0 }] }, 'lines.0.quantity'],
    [{ purchaseOrderId: ghost, lines: [{ quantity: 1 }, { quantity: 1 }] }, 'lines.1.variantId'],
  ])('answers 400 for %o', async (body, field) => {
    const [a] = await newVariants(1);
    const lines = 'lines' in body ? body.lines : [{ quantity: 1 }];

    const response = await receive({
      ...body,
      lines: lines.map((line) => ({ variantId: a, ...line })),
    });

    expect(response.statusCode).toBe(400);
    expect(issuePaths(response)).toContain(field);
  });

  it('keeps each store’s receipts to the people who work there', async () => {
    const supplier = await newParty('Scope Depot');
    const customer = await newParty('Scope Customer', ['customer']);
    const [a] = await newVariants(1);
    const punePo = (
      await order(
        { supplierId: supplier, storeId: pune, lines: [{ variantId: a, quantity: 3 }] },
        owner,
      )
    ).json<Order>();
    const atPune = (
      await receive({ purchaseOrderId: punePo.id, lines: [{ variantId: a, quantity: 1 }] }, owner)
    ).json<Receipt>();
    const atHyd = (
      await receive({
        storeId: hyd,
        supplierId: supplier,
        supplierInvoiceNumber: 'SC-1',
        lines: [{ variantId: a, quantity: 2, unitCostPaise: 100 }],
      })
    ).json<Receipt>();

    const responses = await Promise.all([
      receive({ purchaseOrderId: punePo.id, lines: [{ variantId: a, quantity: 1 }] }),
      receive({
        storeId: pune,
        supplierId: supplier,
        supplierInvoiceNumber: 'SC-2',
        lines: [{ variantId: a, quantity: 1 }],
      }),
      receive({
        storeId: hyd,
        supplierId: customer,
        supplierInvoiceNumber: 'SC-3',
        lines: [{ variantId: a, quantity: 1 }],
      }),
      api(viewer).get(`/goods-receipts/${atPune.id}`),
      api(viewer).get(`/goods-receipts/${ghost}`),
      api(viewer).get(`/goods-receipts?storeId=${pune}`),
    ]);
    const mine = (await api(viewer).get(`/goods-receipts?supplierId=${supplier}`)).json<{
      items: { number: string; purchaseOrderNumber: string | null; totalValuePaise: number }[];
      total: number;
    }>();
    const forOrder = (
      await api(owner).get(`/goods-receipts?purchaseOrderId=${punePo.id}&storeId=${pune}`)
    ).json<{ items: { number: string; purchaseOrderNumber: string | null }[]; total: number }>();

    expect(responses.map((r) => r.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
    expect(message(responses[0])).toBe('Purchase order not found');
    expect(message(responses[2])).toBe('Supplier not found');
    expect(mine).toEqual({
      items: [
        expect.objectContaining({
          number: atHyd.number,
          purchaseOrderNumber: null,
          totalValuePaise: 200,
        }),
      ],
      total: 1,
    });
    expect(forOrder).toEqual({
      items: [
        expect.objectContaining({ number: atPune.number, purchaseOrderNumber: punePo.number }),
      ],
      total: 1,
    });
    expect((await api(viewer).get(`/goods-receipts/${atHyd.id}`)).statusCode).toBe(200);
    expect((await api(viewer).post('/goods-receipts', {})).statusCode).toBe(403);
    expect((await api(cashier).get('/goods-receipts')).statusCode).toBe(403);
  });

  it('never over-receives when two deliveries are entered at the same moment', async () => {
    const supplier = await newParty('Double Entry Depot');
    const [a] = await newVariants(1);
    const po = (
      await order({ supplierId: supplier, storeId: hyd, lines: [{ variantId: a, quantity: 8 }] })
    ).json<Order>();
    const full = { purchaseOrderId: po.id, lines: [{ variantId: a, quantity: 8 }] };

    const results = await whileLocked('purchase_orders', po.id, () =>
      Promise.all([receive(full), receive(full, owner)]),
    );

    // The second waits for the first, then finds nothing left to receive.
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json<{ message: string }>().message).toBe(
      `${po.number} is received`,
    );
    const after = (await api(owner).get(`/purchase-orders/${po.id}`)).json<Order>();
    expect(after).toMatchObject({ status: 'received', lines: [{ receivedQuantity: 8 }] });
    expect((await stockAt(hyd, String(a)))?.onHand).toBe(8);
  });
});

/**
 * Makes a race deterministic: holds a lock on the row so both requests queue
 * behind it, then releases it once both are waiting.
 */
async function whileLocked<T>(table: string, id: string, race: () => Promise<T>): Promise<T> {
  const blocker = new pg.Client({ connectionString: database.connectionString });
  await blocker.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    const racing = race();
    await vi.waitFor(
      async () => {
        // Polled from a separate connection: inside the blocker's transaction
        // pg_stat_activity would keep returning its first snapshot.
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
    return await racing;
  } finally {
    await blocker.end();
  }
}
