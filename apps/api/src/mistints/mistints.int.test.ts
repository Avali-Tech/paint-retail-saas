import { migrateDatabase, postStockMovements, schema, withTenant } from '@paint/db';
import type {
  IssuedInvoiceView,
  MistintPage,
  MistintView,
  TaxCategoryOptions,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  issuesOf,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';

const { stockBalances, stockLedger } = schema;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
/** Counter staff at Ameerpet, and stock staff there and at Kukatpally. */
let cashier: string;
let stockman: string;
let kkpStock: string;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  cashier = await b.member('store_employee', [b.stores.amp]);
  stockman = await b.member('inventory_manager', [b.stores.amp]);
  kkpStock = await b.member('inventory_manager', [b.stores.kkp]);
  // Apex at Ameerpet costs ₹90.00 a litre.
  await withTenant(t.connection.db, b.organizationId, (tx) =>
    postStockMovements(tx, [
      {
        organizationId: b.organizationId,
        storeId: b.stores.amp,
        variantId: b.apex,
        movementType: 'purchase_receipt',
        quantity: 10,
        unitCostPaise: 9_000,
      },
    ]),
  );
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

const onHand = async (storeId = b.stores.amp) => {
  const [row] = await t.connection.db
    .select({ onHand: stockBalances.onHand })
    .from(stockBalances)
    .where(and(eq(stockBalances.storeId, storeId), eq(stockBalances.variantId, b.apex)));
  return Number(row?.onHand);
};

const record = (token: string, extra: object = {}) =>
  api(t, token).post('/mistinted-cans', {
    storeId: b.stores.amp,
    variantId: b.apex,
    quantity: 1,
    shadeCode: 'X110',
    shadeName: 'Ivory Mist',
    intendedShade: 'X101',
    reason: 'Typed X110 for X101',
    ...extra,
  });

describe('recording a mistinted can', () => {
  it('takes it out of sellable stock at its cost, and shows it to every branch', async () => {
    const before = await onHand();
    const can = ok(await record(cashier)).json<MistintView>();

    expect(can).toMatchObject({
      status: 'available',
      store: { id: b.stores.amp, code: 'AMP' },
      variant: { id: b.apex, sku: 'APX-1L' },
      quantity: 1,
      shadeCode: 'X110',
      intendedShade: 'X101',
      lossPaise: null,
      invoice: null,
    });
    expect(can.costPaise).toEqual(expect.any(Number));
    expect(await onHand()).toBe(before - 1);
    const [movement] = await t.connection.db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.referenceId, can.id));
    expect(movement).toMatchObject({ movementType: 'mistint', quantity: -1 });

    // Kukatpally's stock staff see Ameerpet's can; the cost only with costs:read.
    const seen = ok(await api(t, kkpStock).get('/mistinted-cans')).json<MistintPage>();
    expect(seen.items.map((item) => item.id)).toContain(can.id);
    const blind = await b.member('store_employee', [b.stores.kkp], { denied: ['costs:read'] });
    expect(
      ok(await api(t, blind).get(`/mistinted-cans/${can.id}`)).json<MistintView>(),
    ).toMatchObject({ costPaise: null });
  });

  it('is for the store’s own counter or stock staff, with stock to take', async () => {
    expect((await record(kkpStock)).statusCode).toBe(404);
    const reader = await b.member('crm_executive', [b.stores.amp]);
    expect((await record(reader)).statusCode).toBe(403);
    expect((await record(cashier, { quantity: 100_000 })).statusCode).toBe(400);
    // A product with no stock at the store cannot be mistinted from it.
    const o = api(t, b.owner);
    const brandId = ok(await o.post('/brands', { name: 'Shalimar' })).json<{ id: string }>().id;
    const options = ok(await o.get('/tax-categories/options')).json<TaxCategoryOptions>();
    const { variants } = ok(
      await o.post('/products', {
        brandId,
        name: 'No Stock Emulsion',
        type: 'interior_paint',
        hsnCode: '32091090',
        taxCategoryId: options.categories.find((category) => category.key === 'paints')?.id,
        variants: [{ sku: 'NSE-1L', packSize: 1, unit: 'l' }],
      }),
    ).json<{ variants: { id: string }[] }>();
    const empty = await record(cashier, { variantId: variants[0]?.id });
    expect(empty.statusCode).toBe(409);
    expect(empty.json<{ message: string }>().message).toBe('Not enough stock of NSE-1L at AMP');
    expect(issuesOf(await record(cashier, { reason: ' ' }))).toEqual(['reason']);
    expect(
      (await record(cashier, { variantId: '00000000-0000-4000-8000-000000000000' })).statusCode,
    ).toBe(400);
  });
});

describe('writing a mistinted can off', () => {
  it('closes it with all its cost lost, by stock staff at its store, once', async () => {
    const can = ok(await record(cashier)).json<MistintView>();
    const off = (token: string) =>
      api(t, token).post(`/mistinted-cans/${can.id}/write-off`, { note: 'Nobody wants pink' });

    expect((await off(cashier)).statusCode).toBe(403);
    expect((await off(kkpStock)).statusCode).toBe(403);
    const done = ok(await off(stockman)).json<MistintView>();
    expect(done).toMatchObject({ status: 'written_off', note: 'Nobody wants pink' });
    expect(done.lossPaise).toBe(done.costPaise);
    expect(done.resolvedAt).not.toBeNull();
    expect((await off(stockman)).statusCode).toBe(409);
    expect(
      (await api(t, stockman).post(`/mistinted-cans/${can.id}/write-off`, {})).statusCode,
    ).toBe(400);
    expect(
      (
        await api(t, stockman).post(
          '/mistinted-cans/00000000-0000-4000-8000-000000000000/write-off',
          { note: 'Gone' },
        )
      ).statusCode,
    ).toBe(404);
    const written = ok(
      await api(t, stockman).get('/mistinted-cans?status=written_off'),
    ).json<MistintPage>();
    expect(written.items.map((item) => item.id)).toContain(can.id);
  });
});

describe('selling a mistinted can', () => {
  it('bills it at a discount: back in and out as a sale, sold, and back on the list if cancelled', async () => {
    const can = ok(await record(cashier)).json<MistintView>();
    const before = await onHand();
    const line = { variantId: b.apex, quantity: 1, mistintCanId: can.id };

    const draft = await b.draft({
      lines: [{ ...line, discount: { kind: 'percent', basisPoints: 4000 } }],
    });
    const issued = ok(
      await api(t, b.owner).post(`/invoices/${draft.id}/issue`, {}),
    ).json<IssuedInvoiceView>();

    // In for the sale, out as a sale: stock as it was while the can waited.
    expect(await onHand()).toBe(before);
    const moves = await t.connection.db
      .select({ type: stockLedger.movementType, quantity: stockLedger.quantity })
      .from(stockLedger)
      .where(and(eq(stockLedger.storeId, b.stores.amp), eq(stockLedger.variantId, b.apex)));
    expect(moves.filter((move) => move.type === 'sale').at(-1)?.quantity).toBe(-1);
    const sold = ok(await api(t, b.owner).get(`/mistinted-cans/${can.id}`)).json<MistintView>();
    expect(sold).toMatchObject({
      status: 'sold',
      soldTaxablePaise: issued.lines[0]?.taxablePaise,
      invoice: { id: draft.id, number: issued.number },
    });
    expect(sold.lossPaise).toBe(Number(sold.costPaise) - Number(sold.soldTaxablePaise));
    expect(issued.lines[0]).toMatchObject({ mistintCanId: can.id });

    // Sold once: another bill cannot take it.
    expect(
      issuesOf(await api(t, b.owner).post('/invoices', { storeId: b.stores.amp, lines: [line] })),
    ).toEqual(['lines.0.mistintCanId']);

    // Cancelled the same day: the can goes back on the list, and out of sellable stock.
    ok(
      await api(t, b.owner).post(`/invoices/${draft.id}/cancel`, {
        reason: 'Customer changed mind',
      }),
    );
    expect(
      ok(await api(t, b.owner).get(`/mistinted-cans/${can.id}`)).json<MistintView>(),
    ).toMatchObject({
      status: 'available',
      soldTaxablePaise: null,
      invoice: null,
      resolvedAt: null,
    });
    expect(await onHand()).toBe(before);
  });

  it('sells it as it is: its store, its product, its whole quantity', async () => {
    const can = ok(await record(cashier, { quantity: 2 })).json<MistintView>();
    const at = (storeId: string, line: object) =>
      api(t, b.owner).post('/invoices', { storeId, lines: [line] });
    const base = { variantId: b.apex, quantity: 2, mistintCanId: can.id };

    expect(issuesOf(await at(b.stores.kkp, base))).toEqual(['lines.0.mistintCanId']);
    expect(issuesOf(await at(b.stores.amp, { ...base, quantity: 1 }))).toEqual([
      'lines.0.mistintCanId',
    ]);
    expect(
      issuesOf(
        await api(t, b.owner).post('/invoices', { storeId: b.stores.amp, lines: [base, base] }),
      ),
    ).toEqual(['lines.1.mistintCanId']);
    ok(await at(b.stores.amp, base));
  });

  it('refuses at issue a can sold or written off meanwhile', async () => {
    const can = ok(await record(cashier)).json<MistintView>();
    const draft = await b.draft({
      lines: [{ variantId: b.apex, quantity: 1, mistintCanId: can.id }],
    });
    ok(await api(t, stockman).post(`/mistinted-cans/${can.id}/write-off`, { note: 'Spilled' }));
    expect((await api(t, b.owner).post(`/invoices/${draft.id}/issue`, {})).statusCode).toBe(409);
  });
});

describe('the mistinted cans report', () => {
  it('lists each can with what it cost, sold for and lost, the cost for those who may see it', async () => {
    const can = ok(await record(cashier, { shadeCode: 'R200' })).json<MistintView>();
    ok(await api(t, stockman).post(`/mistinted-cans/${can.id}/write-off`, { note: 'Faded' }));
    interface Report {
      columns: { key: string }[];
      rows: Record<string, unknown>[];
    }
    const report = ok(await api(t, b.owner).get('/reports/mistinted-cans')).json<Report>();
    expect(report.rows.find((row) => row.shade === 'R200')).toMatchObject({
      store: 'AMP',
      sku: 'APX-1L',
      reason: 'Faded',
      status: 'written_off',
      soldFor: null,
      loss: expect.any(String) as string,
    });
    // Waiting cans have no loss yet.
    expect(report.rows.some((row) => row.status === 'available' && row.loss === null)).toBe(true);

    const blind = await b.member('store_employee', [b.stores.amp], { denied: ['costs:read'] });
    const seen = ok(await api(t, blind).get('/reports/mistinted-cans')).json<Report>();
    expect(seen.columns.map((column) => column.key)).not.toContain('loss');
    expect(seen.columns.map((column) => column.key)).toContain('soldFor');
  });
});
