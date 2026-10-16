import { migrateDatabase } from '@paint/db';
import { parseCsv, type TaxDocumentView } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  dbToday,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import type { ReportPage, ReportSummary } from './reports.service.js';

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let painter: string;
let villa: string;

const report = async (kind: string, query = '', token = b.owner) =>
  ok(await api(t, token).get(`/reports/${kind}${query ? `?${query}` : ''}`)).json<ReportPage>();

/** An issued invoice of `litres` of Apex (₹118 a litre, inclusive) with the sale's fields. */
async function sale(body: object, litres: number, storeId = b.stores.amp) {
  const draft = await b.draft({
    storeId,
    lines: [{ variantId: b.apex, quantity: litres }],
    ...body,
  });
  return ok(await api(t, b.owner).post(`/invoices/${draft.id}/issue`)).json<TaxDocumentView>();
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  const o = api(t, b.owner);
  painter = ok(
    await o.post('/parties', {
      displayName: 'Ravi Painter',
      phone: uniquePhone(),
      roles: ['painter', 'customer'],
    }),
  ).json<{ id: string }>().id;
  villa = ok(
    await o.post('/projects', {
      storeId: b.stores.amp,
      customerPartyId: b.parties.homeowner,
      name: 'Suresh villa',
      city: 'Hyderabad',
      state: 'Telangana',
    }),
  ).json<{ id: string }>().id;

  // The homeowner's invoice at the villa, brought in by the painter, later credited ₹118.
  const villaSale = await sale(
    { partyId: b.parties.homeowner, influencerPartyId: painter, projectId: villa },
    10,
  );
  ok(
    await o.post('/credit-notes', {
      invoiceId: villaSale.id,
      reason: 'overcharge',
      note: 'Billed at the old price',
      lines: [{ invoiceLineId: villaSale.lines[0]?.id, valuePaise: 118_00 }],
    }),
  );
  // The same painter with the contractor at Kukatpally, no site.
  await sale({ partyId: b.parties.contractor, influencerPartyId: painter }, 2, b.stores.kkp);
  // A villa sale nobody brought in.
  await sale({ partyId: b.parties.homeowner, projectId: villa }, 1);
  // Neither a draft nor a cancelled invoice counts.
  await b.draft({
    partyId: b.parties.homeowner,
    influencerPartyId: painter,
    projectId: villa,
    lines: [{ variantId: b.apex, quantity: 50 }],
  });
  const cancelled = await sale({ influencerPartyId: painter, projectId: villa }, 30);
  ok(await o.post(`/invoices/${cancelled.id}/cancel`, { reason: 'Wrong item' }));
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('sales by influencer', () => {
  it('credits the painter per site, invoices minus credit notes', async () => {
    const today = await dbToday(t);
    const page = await report('sales-by-influencer');

    expect(page.total).toBe(2);
    expect(page.rows).toEqual([
      {
        influencer: 'Ravi Painter',
        roles: 'painter',
        phone: expect.any(String),
        site: expect.stringMatching(/ Suresh villa$/),
        customers: 'Suresh',
        invoices: 1,
        creditNotes: 1,
        lastBilled: today,
        taxable: '900.00',
        total: '1062.00',
        points: 0,
      },
      {
        influencer: 'Ravi Painter',
        roles: 'painter',
        phone: expect.any(String),
        site: null,
        customers: 'Deccan Contractors',
        invoices: 1,
        creditNotes: 0,
        lastBilled: today,
        taxable: '200.00',
        total: '236.00',
        points: 0,
      },
    ]);
    expect(page.columns.map((c) => c.id)).toContain('sales-by-influencer.customers');
  });

  it('keeps to the chosen store and dates, and to the member’s stores', async () => {
    const today = await dbToday(t);
    const yesterday = await dbToday(t, -1);
    const kkp = await report('sales-by-influencer', `storeId=${b.stores.kkp}`);
    expect(kkp.rows.map((r) => r.customers)).toEqual(['Deccan Contractors']);
    expect((await report('sales-by-influencer', `from=${today}&to=${today}`)).total).toBe(2);
    expect((await report('sales-by-influencer', `to=${yesterday}`)).total).toBe(0);

    const kukatpally = await b.member('sales_executive', [b.stores.kkp]);
    const theirs = await report('sales-by-influencer', '', kukatpally);
    expect(theirs.rows.map((r) => r.total)).toEqual(['236.00']);
    expect((await report('sales-by-site', '', kukatpally)).total).toBe(0);
  });

  it('downloads as CSV', async () => {
    const reply = ok(await api(t, b.owner).get('/reports/sales-by-influencer?format=csv'));
    const [header, first] = parseCsv(reply.body.slice(1));
    expect(header).toEqual([
      'Influencer',
      'Role',
      'Mobile',
      'Site',
      'Billed to',
      'Bills',
      'Credit notes',
      'Last billed',
      'Taxable value (₹)',
      'Net sales (₹)',
      'Painter points',
    ]);
    expect(first?.slice(-2)).toEqual(['1062.00', '0']);
  });
});

describe('sales by site', () => {
  it('totals each site with the influencers who brought its sales', async () => {
    const page = await report('sales-by-site');
    expect(page.rows).toEqual([
      {
        number: expect.any(String),
        site: 'Suresh villa',
        customer: 'Suresh',
        city: 'Hyderabad',
        influencers: 'Ravi Painter',
        invoices: 2,
        creditNotes: 1,
        lastBilled: await dbToday(t),
        taxable: '1000.00',
        total: '1180.00',
      },
    ]);
  });

  it('is for members who may read sales', async () => {
    const list = ok(await api(t, b.owner).get('/reports')).json<ReportSummary[]>();
    const sales = list.filter((r) => r.kind.startsWith('sales-by-'));
    expect(sales.map((r) => [r.kind, r.filters.map((f) => f.name)])).toEqual([
      ['sales-by-influencer', ['storeId', 'from', 'to']],
      ['sales-by-site', ['storeId', 'from', 'to']],
    ]);
    const stock = await b.member('inventory_manager', [b.stores.amp]);
    expect((await api(t, stock).get('/reports/sales-by-site')).statusCode).toBe(403);
  });
});
