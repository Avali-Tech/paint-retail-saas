import { migrateDatabase } from '@paint/db';
import { parseCsv } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { istDate, seedBusiness, type Business } from '../test-support/business.js';
import { bearer, startTestApp, type TestApp } from '../test-support/test-app.js';
import type { ReportPage, ReportSummary } from './reports.service.js';

let database: TestDatabase;
let t: TestApp;
let business: Business;

const get = (token: string, url: string) =>
  t.app.inject({ method: 'GET', url, headers: bearer(token) });
const report = async (kind: string, query = '', token = business.owner) =>
  (await get(token, `/reports/${kind}${query ? `?${query}` : ''}`)).json<ReportPage>();
const column = (page: ReportPage, key: string) => page.rows.map((row) => row[key]);

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  business = await seedBusiness(t);
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('report list', () => {
  it('offers each member the reports they may run', async () => {
    const owner = (await get(business.owner, '/reports')).json<ReportSummary[]>();
    const cashier = (await get(business.cashier, '/reports')).json<ReportSummary[]>();

    expect(owner.map((r) => r.kind)).toEqual([
      'stock-by-location',
      'stock-ledger',
      'transfers',
      'goods-receipts',
      'leads',
      'projects',
      'sales-by-influencer',
      'sales-by-site',
      'receivables-ageing',
      'receivables-open-bills',
      'brand-schemes',
      'brand-scheme-claims',
    ]);
    // Each filter says what input it takes, so the app builds them without copying enums.
    expect(owner[0]?.filters).toEqual([
      { name: 'storeId', type: 'store' },
      { name: 'inStockOnly', type: 'boolean', default: 'true' },
    ]);
    expect(owner[1]?.filters).toEqual([
      { name: 'storeId', type: 'store' },
      { name: 'from', type: 'date' },
      { name: 'to', type: 'date' },
      {
        name: 'movementType',
        type: 'enum',
        values: [
          'opening',
          'purchase_receipt',
          'purchase_return',
          'transfer_in',
          'transfer_out',
          'sale',
          'sale_return',
          'adjustment',
          'damage',
          'count_correction',
        ],
      },
    ]);
    expect(owner[3]?.filters.at(-1)).toEqual({ name: 'supplierId', type: 'supplier' });
    expect(owner[4]?.filters.map((f) => [f.name, f.type, f.values?.length])).toEqual([
      ['storeId', 'store', undefined],
      ['from', 'date', undefined],
      ['to', 'date', undefined],
      ['stage', 'enum', 6],
      ['source', 'enum', 10],
    ]);
    // Columns carry an id that stays the same, for translating headers.
    expect(owner[2]?.columns.at(-1)).toEqual({
      id: 'transfers.value',
      key: 'value',
      header: 'Dispatched value (₹)',
    });
    for (const summary of owner) {
      expect(summary.columns.every((c) => c.id === `${summary.kind}.${c.key}`)).toBe(true);
    }
    expect(cashier.map((r) => r.kind)).toEqual([
      'stock-by-location',
      'stock-ledger',
      'transfers',
      'sales-by-influencer',
      'sales-by-site',
    ]);
    expect((await get(business.cashier, '/reports/goods-receipts')).statusCode).toBe(403);
    expect((await get(business.owner, '/reports/sales')).statusCode).toBe(404);
  });
});

describe('stock reports', () => {
  it('lists stock by location with value, in rupees', async () => {
    const page = await report('stock-by-location');
    const everything = await report('stock-by-location', 'inStockOnly=false');

    expect(page.rows.map((r) => [r.store, r.sku])).toEqual([
      ['HYD', 'APX-1L'],
      ['HYD', 'APX-4L'],
      ['PUN', 'APX-10L'],
      ['PUN', 'APX-1L'],
    ]);
    expect(page.rows[0]).toEqual({
      store: 'HYD',
      sku: 'APX-1L',
      brand: 'Asian Paints',
      product: 'Apex',
      variant: '1 l',
      onHand: 13,
      reserved: 0,
      available: 13,
      averageCost: '92.31',
      value: '1200.03',
    });
    expect(page.rows[2]).toMatchObject({ onHand: 5, averageCost: null, value: null });
    expect(page.columns[8]).toEqual({
      id: 'stock-by-location.averageCost',
      key: 'averageCost',
      header: 'Average cost (₹)',
    });
    expect(everything.total).toBeGreaterThanOrEqual(page.total);
  });

  it('keeps to the member’s stores', async () => {
    const own = await report('stock-by-location', '', business.manager);
    const pune = await report('stock-by-location', `storeId=${business.stores.pune}`);

    expect([...new Set(column(own, 'store'))]).toEqual(['HYD']);
    expect([...new Set(column(pune, 'store'))]).toEqual(['PUN']);
    expect(
      (await get(business.manager, `/reports/stock-by-location?storeId=${business.stores.pune}`))
        .statusCode,
    ).toBe(404);
  });

  it('lists the stock ledger, filtered by movement type and India-time days', async () => {
    const all = await report('stock-ledger', 'limit=500');
    const damage = await report('stock-ledger', 'movementType=damage');
    // The India-time days the entries were made on, read back from the report
    // itself, so a run that crosses midnight still checks the right days.
    const days = column(all, 'at')
      .map((at) => String(at).slice(0, 10))
      .sort();
    const first = String(days[0]);
    const last = String(days.at(-1));
    const shift = (day: string, by: number) =>
      new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
    const today = await report('stock-ledger', `from=${first}&to=${last}`);
    const tomorrow = await report('stock-ledger', `from=${shift(last, 1)}`);
    const before = await report('stock-ledger', `to=${shift(first, -1)}`);

    expect(all.total).toBe(all.rows.length);
    expect(damage.rows).toEqual([
      expect.objectContaining({
        store: 'PUN',
        sku: 'APX-10L',
        type: 'damage',
        quantity: -0.5,
        unitCost: null,
        note: 'Leaking tin',
        by: 'Anil Owner',
      }),
    ]);
    expect(damage.rows[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(today.total).toBe(all.total);
    expect([tomorrow.total, before.total]).toEqual([0, 0]);
    expect(column(all, 'unitCost')).toContain('110.00');
  });

  it('lists transfers with their dispatched value', async () => {
    const all = await report('transfers');
    const inTransit = await report('transfers', 'status=in_transit');
    const sec = await report('transfers', `storeId=${business.stores.sec}`);

    expect(all.total).toBe(4);
    expect(inTransit.rows).toEqual([
      expect.objectContaining({
        from: 'PUN',
        to: 'HYD',
        status: 'in_transit',
        products: 1,
        value: '330.00',
      }),
    ]);
    expect(inTransit.rows[0]?.dispatchedAt).toMatch(/^\d{4}-/);
    expect(sec.rows).toEqual([
      expect.objectContaining({ to: 'SEC', status: 'requested', value: null, receivedAt: null }),
    ]);
  });
});

describe('purchasing and sales reports', () => {
  it('lists goods receipts with paid and free units', async () => {
    const page = await report(
      'goods-receipts',
      `supplierId=${business.supplier}&from=${istDate(0)}`,
    );
    const other = await report('goods-receipts', 'supplierId=00000000-0000-4000-8000-000000000000');

    expect(page.rows).toEqual([
      expect.objectContaining({
        store: 'HYD',
        supplier: 'Asian Depot',
        invoice: 'AD/101',
        invoiceDate: null,
        purchaseOrder: expect.stringMatching(/^PO-/),
        paidUnits: 2,
        freeUnits: 1,
        value: '200.00',
      }),
    ]);
    expect(other.total).toBe(0);
    expect((await report('goods-receipts')).total).toBe(1);
  });

  it('lists leads and projects by stage and source', async () => {
    const leads = await report('leads');
    const lost = await report('leads', 'stage=lost');
    const referrals = await report('leads', `source=referral&to=${istDate(0)}`);
    const projects = await report('projects');
    const surveys = await report('projects', 'stage=survey');

    expect(leads.total).toBe(3);
    expect(lost.rows).toEqual([
      expect.objectContaining({
        title: 'Old enquiry',
        lostReason: 'No budget',
        estimatedValue: null,
      }),
    ]);
    expect(referrals.rows).toEqual([
      expect.objectContaining({
        title: 'Pune villa',
        stage: 'qualified',
        contact: 'Sharma Builders',
        assignedTo: 'Anil Owner',
      }),
    ]);
    expect(column(leads, 'estimatedValue')).toContain('1000.00');
    expect(projects.rows).toContainEqual(
      expect.objectContaining({
        name: 'Gachibowli Heights',
        city: 'Hyderabad',
        expectedValue: '9000.00',
        areaSqFt: null,
      }),
    );
    expect(column(surveys, 'name')).toEqual(['Pune office']);
  });
});

describe('paging and export', () => {
  it('pages JSON and checks filters', async () => {
    const first = await report('stock-ledger', 'limit=2');
    const second = await report('stock-ledger', 'limit=2&offset=2');

    expect(first.rows).toHaveLength(2);
    expect(second.rows[0]).not.toEqual(first.rows[0]);
    expect(second.total).toBe(first.total);
    expect((await get(business.owner, '/reports/transfers?status=lost')).statusCode).toBe(400);
    expect((await get(business.owner, '/reports/transfers?limit=0')).statusCode).toBe(400);
  });

  it('downloads the whole report as CSV for Excel', async () => {
    const response = await get(business.owner, '/reports/stock-by-location?format=csv');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="stock-by-location-${istDate(0)}.csv"; filename*=UTF-8''stock-by-location-${istDate(0)}.csv`,
    );
    expect(response.body.startsWith('﻿')).toBe(true);
    const [header, ...rows] = parseCsv(response.body);
    expect(header).toEqual([
      'Store',
      'SKU',
      'Brand',
      'Product',
      'Size / pack',
      'On hand',
      'Reserved',
      'Available',
      'Average cost (₹)',
      'Value (₹)',
    ]);
    expect(rows).toHaveLength(4);
    expect(rows[2]).toEqual([
      'PUN',
      'APX-10L',
      'Asian Paints',
      'Apex',
      '10 l',
      '5',
      '0',
      '5',
      '',
      '',
    ]);
    expect((await get(business.cashier, '/reports/leads?format=csv')).statusCode).toBe(403);
  });
});
