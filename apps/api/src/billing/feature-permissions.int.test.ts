import { migrateDatabase, postStockMovements, withTenant } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  ok,
  type BillingBusiness,
  type Reply,
} from '../test-support/billing-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';

// The permissions split out of broader ones (migration 0093): each is enforced
// by the API, not only hidden on screen.

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
/** A Store Employee at Ameerpet, as the role is. */
let cashier: string;
/** The same, with billing:discount and billing:on_account denied. */
let strict: string;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  cashier = await b.member('store_employee', [b.stores.amp]);
  strict = await b.member('store_employee', [b.stores.amp], {
    denied: ['billing:discount', 'billing:on_account'],
  });
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

const issues = (reply: Reply) =>
  reply.json<{ issues: { path: string; message: string }[] }>().issues;

describe('billing:discount', () => {
  const line = (extra: object = {}) => ({ variantId: b.apex, quantity: 1, ...extra });
  const bill = (token: string, body: object) =>
    api(t, token).post('/invoices', { storeId: b.stores.amp, lines: [line()], ...body });

  it('lets a counter with it give discounts and change prices', async () => {
    ok(await bill(cashier, { lines: [line({ discount: { kind: 'percent', basisPoints: 500 } })] }));
    ok(await bill(cashier, { lines: [line({ unitPricePaise: 11_000 })] }));
    ok(await bill(cashier, { billDiscount: { kind: 'amount', paise: 100 } }));
  });

  it('refuses discounts and changed prices without it, but takes the catalogue price', async () => {
    const lineDiscount = await bill(strict, {
      lines: [line(), line({ discount: { kind: 'amount', paise: 500 } })],
    });
    const price = await bill(strict, { lines: [line({ unitPricePaise: 11_000 })] });
    const billDiscount = await bill(strict, {
      billDiscount: { kind: 'percent', basisPoints: 100 },
    });

    expect(lineDiscount.statusCode).toBe(400);
    expect(issues(lineDiscount)).toEqual([
      { path: 'lines.1.discount', message: 'You cannot give discounts' },
    ]);
    expect(issues(price)).toEqual([
      { path: 'lines.0.unitPricePaise', message: 'You cannot change the price' },
    ]);
    expect(issues(billDiscount)).toEqual([
      { path: 'billDiscount', message: 'You cannot give discounts' },
    ]);
    // The catalogue price sent back as it is, or a zero discount, is no discount.
    ok(
      await bill(strict, {
        lines: [line({ unitPricePaise: 11_800, discount: { kind: 'percent', basisPoints: 0 } })],
      }),
    );
  });

  it('checks a held bill when it is changed, and quotations and orders too', async () => {
    const held = await b.draft({ lines: [line()] }, strict);
    const changed = await api(t, strict).put(`/invoices/${held.id}`, {
      storeId: b.stores.amp,
      lines: [line({ unitPricePaise: 9_000 })],
    });
    const sale = {
      storeId: b.stores.amp,
      billToPartyId: b.parties.homeowner,
      lines: [line({ discount: { kind: 'percent', basisPoints: 1000 } })],
    };
    const sales = await b.member('sales_executive', [b.stores.amp], {
      denied: ['billing:discount'],
    });
    const quote = await api(t, sales).post('/quotations', sale);
    const order = await api(t, sales).post('/sales-orders', { ...sale, paymentTerms: 'prepaid' });

    expect(issues(changed)).toEqual([
      { path: 'lines.0.unitPricePaise', message: 'You cannot change the price' },
    ]);
    for (const reply of [quote, order]) {
      expect(issues(reply)).toEqual([
        { path: 'lines.0.discount', message: 'You cannot give discounts' },
      ]);
    }
  });
});

describe('billing:on_account', () => {
  const issue = async (token: string, body: object) => {
    const draft = await b.draft(
      { partyId: b.parties.homeowner, lines: [{ variantId: b.apex, quantity: 1 }] },
      token,
    );
    return api(t, token).post(`/invoices/${draft.id}/issue`, body);
  };

  it('lets a counter with it leave a bill on the customer’s account', async () => {
    const reply = ok(await issue(cashier, {}));
    expect(reply.json<{ outstandingPaise: number }>().outstandingPaise).toBe(11_800);
  });

  it('without it, a bill is paid in full with the issue', async () => {
    const unpaid = await issue(strict, {});
    const part = await issue(strict, { payments: [{ modeId: b.modes.upi.id, amountPaise: 800 }] });

    for (const reply of [unpaid, part]) {
      expect(reply.statusCode).toBe(403);
      expect(reply.json<{ message: string }>().message).toBe(
        'You cannot leave a bill on account: take the full ₹118.00 (or use advances)',
      );
    }
    ok(await issue(strict, { payments: [{ modeId: b.modes.upi.id, amountPaise: 11_800 }] }));
  });

  it('without it, an order on credit cannot be confirmed', async () => {
    const sales = await b.member('sales_executive', [b.stores.amp], {
      denied: ['billing:on_account'],
    });
    const order = ok(
      await api(t, sales).post('/sales-orders', {
        storeId: b.stores.amp,
        billToPartyId: b.parties.homeowner,
        paymentTerms: 'postpaid',
        lines: [{ variantId: b.apex, quantity: 1 }],
      }),
    ).json<{ id: string }>();

    const confirm = await api(t, sales).post(`/sales-orders/${order.id}/confirm`, {});

    expect(confirm.statusCode).toBe(403);
    expect(confirm.json<{ message: string }>().message).toBe(
      'You cannot sell on account: make the order prepaid, or ask someone who can',
    );
  });
});

describe('data:export', () => {
  it('is needed to download a report as CSV, not to see it', async () => {
    const viewer = await b.member('store_employee', [b.stores.amp], { denied: ['data:export'] });

    const page = await api(t, viewer).get('/reports/sales-by-product');
    const csv = await api(t, viewer).get('/reports/sales-by-product?format=csv');
    const allowed = await api(t, cashier).get('/reports/sales-by-product?format=csv');

    expect(page.statusCode).toBe(200);
    expect(csv.statusCode).toBe(403);
    expect(csv.json<{ message: string }>().message).toBe('You cannot download data');
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['content-type']).toContain('text/csv');
  });

  it('is needed for the brand profitability CSV and a statement’s mismatches', async () => {
    const admin = await b.member('org_admin', [], { denied: ['data:export'] });

    const profitability = await api(t, admin).get('/reports/brand-profitability?format=csv');
    const mismatches = await api(t, admin).get(
      '/brand-statements/00000000-0000-4000-8000-000000000000/mismatches.csv',
    );

    expect(profitability.statusCode).toBe(403);
    expect(mismatches.statusCode).toBe(403);
  });
});

describe('costs:read', () => {
  let viewer: string;

  beforeAll(async () => {
    viewer = await b.member('store_employee', [b.stores.amp], { denied: ['costs:read'] });
    // Stock received at a cost, so there is an average cost and a value to hide.
    await withTenant(t.connection.db, b.organizationId, (tx) =>
      postStockMovements(tx, [
        {
          organizationId: b.organizationId,
          storeId: b.stores.amp,
          variantId: b.apex,
          movementType: 'opening',
          quantity: 10,
          unitCostPaise: 9_000,
        },
      ]),
    );
  });

  interface StockPage {
    items: { avgCostPaise: number | null; valuePaise: number | null }[];
  }
  const stockOf = async (token: string) =>
    ok(await api(t, token).get(`/stock?storeId=${b.stores.amp}`)).json<StockPage>().items[0];

  it('hides average cost and value on stock and the stock ledger', async () => {
    expect(await stockOf(cashier)).toMatchObject({ avgCostPaise: expect.any(Number) as number });
    expect(await stockOf(viewer)).toMatchObject({ avgCostPaise: null, valuePaise: null });

    const ledger = (token: string) =>
      api(t, token).get(`/stock/ledger?storeId=${b.stores.amp}&variantId=${b.apex}`);
    const costs = (reply: Reply) =>
      reply.json<{ items: { unitCostPaise: number | null }[] }>().items.map((e) => e.unitCostPaise);
    expect(costs(ok(await ledger(cashier)))).toContain(9_000);
    expect(costs(ok(await ledger(viewer))).every((cost) => cost === null)).toBe(true);
  });

  it('leaves the stock value off the dashboard', async () => {
    interface Dashboard {
      stores: { stock: { valuePaise: number | null; units: number } | null }[];
      totals: { stock: { valuePaise: number | null; units: number } | null };
    }
    const dashboard = async (token: string) => ok(await api(t, token).get('/dashboard'));
    const seen = (await dashboard(viewer)).json<Dashboard>();
    const shown = (await dashboard(cashier)).json<Dashboard>();

    expect(seen.stores[0]?.stock?.valuePaise).toBeNull();
    expect(seen.totals.stock?.valuePaise).toBeNull();
    expect(seen.stores[0]?.stock?.units).toBe(shown.stores[0]?.stock?.units);
    expect(shown.totals.stock?.valuePaise).toEqual(expect.any(Number));
  });

  it('drops the cost columns from reports and their CSV', async () => {
    interface Report {
      columns: { key: string }[];
      rows: Record<string, unknown>[];
    }
    const report = async (token: string, kind: string) =>
      ok(await api(t, token).get(`/reports/${kind}?storeId=${b.stores.amp}`)).json<Report>();
    const keys = (r: Report) => r.columns.map((column) => column.key);

    const hidden = await report(viewer, 'stock-by-location');
    expect(keys(hidden)).not.toContain('averageCost');
    expect(keys(hidden)).not.toContain('value');
    expect(Object.keys(hidden.rows[0] ?? {})).not.toContain('averageCost');
    expect(keys(await report(cashier, 'stock-by-location'))).toContain('averageCost');
    // A report with nothing at cost is the same for both.
    expect(keys(await report(viewer, 'sales-by-product'))).toEqual(
      keys(await report(cashier, 'sales-by-product')),
    );
    const csv = ok(await api(t, viewer).get('/reports/stock-by-location?format=csv'));
    expect(csv.body.split('\n')[0]).not.toContain('Average cost');
    expect(csv.body.split('\n')[0]).toContain('On hand');
  });

  it('is needed for brand profitability and the price-hike plan', async () => {
    const admin = await b.member('org_admin', [], { denied: ['costs:read'] });
    const kinds = ok(await api(t, admin).get('/reports'))
      .json<{ kind: string }[]>()
      .map((r) => r.kind);

    expect(kinds).not.toContain('brand-profitability');
    expect(kinds).toContain('gst-summary');
    expect((await api(t, admin).get('/reports/brand-profitability')).statusCode).toBe(403);
    expect((await api(t, admin).post('/brand-schemes/price-hike-plan', {})).statusCode).toBe(403);
  });
});
