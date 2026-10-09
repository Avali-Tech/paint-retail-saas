import { migrateDatabase, withTenant } from '@paint/db';
import type { EstimatePage, EstimateView, QuotationView, TaxCategoryOptions } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  issuesOf,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let apex: string;
let primer: string;
let putty: string;
let brush: string;
let premium: string;
let site: string;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  const o = api(t, b.owner);
  const found = ok(await o.get('/products?q=Apex')).json<{
    items: { id: string; brand: { id: string } }[];
  }>().items[0];
  apex = String(found?.id);
  const brandId = String(found?.brand.id);
  ok(await o.patch(`/products/${apex}`, { coverageSqftPerLitre: 120, defaultCoats: 2 }));
  const options = ok(await o.get('/tax-categories/options')).json<TaxCategoryOptions>();
  const paints = String(options.categories.find((category) => category.key === 'paints')?.id);
  const product = async (name: string, type: string, extra: object = {}) =>
    ok(
      await o.post('/products', {
        brandId,
        name,
        type,
        hsnCode: '32091090',
        taxCategoryId: paints,
        variants: [{ sku: `${name.slice(0, 3).toUpperCase()}-1`, packSize: 1, unit: 'l' }],
        ...extra,
      }),
    ).json<{ id: string }>().id;
  primer = await product('Primer', 'primer', { coverageSqftPerLitre: 150 });
  putty = await product('Putty', 'putty');
  brush = await product('Brush', 'tool');
  premium = await product('Royale', 'interior_paint', {
    coverageSqftPerLitre: 140.5,
    defaultCoats: 3,
    isTintable: true,
  });
  site = ok(
    await o.post('/projects', {
      storeId: b.stores.amp,
      customerPartyId: b.parties.homeowner,
      name: 'Suresh villa',
    }),
  ).json<{ id: string }>().id;
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

const owner = () => api(t, b.owner);
/** Three rooms, 1,350 sq ft net (spec §6.2's example). */
const threeRooms = [
  {
    room: 'Living room',
    kind: 'interior_wall',
    lengthFt: 50,
    heightFt: 10,
    openingsSqft: 40,
    condition: 'repaint',
  },
  { room: 'Bedroom', kind: 'interior_wall', areaSqft: 460, condition: 'new' },
  {
    room: 'Bedroom',
    kind: 'ceiling',
    areaSqft: 430.5,
    openingsSqft: 0.5,
    condition: 'damaged',
    coats: 1,
    primer: false,
  },
];
const body = (extra: object = {}) => ({
  storeId: b.stores.amp,
  partyId: b.parties.homeowner,
  projectId: site,
  title: 'Suresh villa repaint',
  surfaces: threeRooms,
  options: [
    { tier: 'best', productId: premium, primerProductId: primer, puttyProductId: putty },
    { tier: 'good', productId: apex },
  ],
  ...extra,
});
const create = async (extra: object = {}, token = b.owner) =>
  ok(await api(t, token).post('/estimates', body(extra))).json<EstimateView>();

describe('POST /estimates', () => {
  it('keeps the surfaces in order with their areas, and the options by tier', async () => {
    const headers = { 'idempotency-key': 'estimate-1' };
    const first = ok(await api(t, b.owner, headers).post('/estimates', body()));
    const created = first.json<EstimateView>();
    expect(created).toMatchObject({
      number: expect.stringMatching(/^ES-\d{6}$/),
      status: 'draft',
      storeId: b.stores.amp,
      party: { id: b.parties.homeowner, name: 'Suresh', phone: expect.any(String) },
      project: { id: site, name: 'Suresh villa' },
      title: 'Suresh villa repaint',
      wastageBps: 500,
      note: null,
      totalNetAreaSqft: 1_350,
      quotationId: null,
      quotationNumber: null,
      convertedTier: null,
      convertedAt: null,
    });
    expect(created.surfaces).toEqual([
      expect.objectContaining({
        position: 1,
        room: 'Living room',
        kind: 'interior_wall',
        areaSqft: null,
        lengthFt: 50,
        heightFt: 10,
        openingsSqft: 40,
        condition: 'repaint',
        coats: null,
        // A repaint gets neither primer nor putty unless asked.
        primer: false,
        putty: false,
        grossAreaSqft: 500,
        netAreaSqft: 460,
      }),
      expect.objectContaining({
        position: 2,
        areaSqft: 460,
        openingsSqft: 0,
        primer: true,
        putty: true,
        netAreaSqft: 460,
      }),
      expect.objectContaining({
        position: 3,
        kind: 'ceiling',
        coats: 1,
        primer: false,
        putty: true,
        grossAreaSqft: 430.5,
        netAreaSqft: 430,
      }),
    ]);
    expect(created.options).toEqual([
      {
        id: expect.any(String),
        tier: 'good',
        product: {
          id: apex,
          name: 'Apex Ultima',
          brandName: 'Asian Paints',
          coverageSqftPerLitre: 120,
          defaultCoats: 2,
          isActive: true,
        },
        primerProduct: null,
        puttyProduct: null,
        result: null,
      },
      {
        id: expect.any(String),
        tier: 'best',
        product: expect.objectContaining({
          id: premium,
          coverageSqftPerLitre: 140.5,
          defaultCoats: 3,
        }),
        primerProduct: expect.objectContaining({ id: primer, coverageSqftPerLitre: 150 }),
        puttyProduct: expect.objectContaining({ id: putty, coverageSqftPerLitre: null }),
        result: null,
      },
    ]);
    // A retry with the same key is the same estimate.
    const again = ok(await api(t, b.owner, headers).post('/estimates', body()));
    expect(again.json<EstimateView>().id).toBe(created.id);
  });

  it('takes an estimate with no customer or options yet', async () => {
    const bare = await create({
      partyId: undefined,
      projectId: undefined,
      title: undefined,
      options: undefined,
      wastageBps: 0,
      note: 'Measure the balcony next visit',
    });
    expect(bare).toMatchObject({
      party: null,
      project: null,
      title: null,
      wastageBps: 0,
      note: 'Measure the balcony next visit',
      options: [],
    });
  });

  it('refuses a surface measured twice or not at all, and openings larger than the wall', async () => {
    const surface = (extra: object) =>
      body({ surfaces: [{ room: 'Hall', kind: 'exterior', condition: 'new', ...extra }] });
    const refused = async (payload: object) => {
      const reply = await owner().post('/estimates', payload);
      expect(reply.statusCode).toBe(400);
      return issuesOf(reply);
    };
    expect(await refused(surface({}))).toEqual(['surfaces.0.areaSqft']);
    expect(await refused(surface({ areaSqft: 10, lengthFt: 2 }))).toEqual(['surfaces.0.areaSqft']);
    expect(await refused(surface({ lengthFt: 2 }))).toEqual(['surfaces.0.heightFt']);
    expect(await refused(surface({ heightFt: 2 }))).toEqual(['surfaces.0.lengthFt']);
    expect(await refused(surface({ lengthFt: 10, heightFt: 10, openingsSqft: 100.01 }))).toEqual([
      'surfaces.0.openingsSqft',
    ]);
    expect(await refused(surface({ lengthFt: 1000, heightFt: 1000.01 }))).toEqual([
      'surfaces.0.heightFt',
    ]);
    expect(await refused(surface({ areaSqft: 10.005 }))).toEqual(['surfaces.0.areaSqft']);
    expect(await refused(surface({ areaSqft: 10, coats: 6 }))).toEqual(['surfaces.0.coats']);
    expect(await refused(body({ surfaces: [] }))).toEqual(['surfaces']);
    expect(
      await refused(
        body({
          options: [
            { tier: 'good', productId: apex },
            { tier: 'good', productId: premium },
          ],
        }),
      ),
    ).toEqual(['options']);
    expect(await refused(body({ wastageBps: 5001 }))).toEqual(['wastageBps']);
  });

  it('needs paint with a coverage, active products, and a known store, customer and site', async () => {
    const refused = async (payload: object) => {
      const reply = await owner().post('/estimates', body(payload));
      expect(reply.statusCode).toBe(400);
      return reply.json<{ issues: { path: string; message: string }[] }>().issues;
    };
    expect(await refused({ options: [{ tier: 'good', productId: brush }] })).toEqual([
      {
        path: 'options.0.productId',
        message: 'Enter this product’s coverage (sq ft per litre) first',
      },
    ]);
    expect(
      await refused({ options: [{ tier: 'better', productId: apex, primerProductId: putty }] }),
    ).toEqual([expect.objectContaining({ path: 'options.0.primerProductId' })]);
    expect(
      await refused({
        options: [{ tier: 'better', productId: apex, puttyProductId: crypto.randomUUID() }],
      }),
    ).toEqual([{ path: 'options.0.puttyProductId', message: 'Unknown product' }]);
    expect(await refused({ storeId: crypto.randomUUID() })).toEqual([
      { path: 'storeId', message: 'Unknown store' },
    ]);
    expect((await refused({ partyId: crypto.randomUUID() }))[0]?.path).toBe('partyId');
    expect((await refused({ projectId: crypto.randomUUID() }))[0]?.path).toBe('projectId');

    ok(await owner().patch(`/products/${brush}`, { isActive: false }));
    ok(await owner().patch(`/products/${brush}`, { coverageSqftPerLitre: 100 }));
    expect(await refused({ options: [{ tier: 'good', productId: brush }] })).toEqual([
      { path: 'options.0.productId', message: 'Unknown product' },
    ]);
  });

  it('is written by sales staff at their own stores', async () => {
    const employee = await b.member('store_employee', [b.stores.amp]);
    expect((await api(t, employee).post('/estimates', body())).statusCode).toBe(403);
    const kukatpally = await b.member('sales_executive', [b.stores.kkp]);
    expect((await api(t, kukatpally).post('/estimates', body())).statusCode).toBe(403);
    const atKukatpally = await create({ storeId: b.stores.kkp }, kukatpally);
    expect(atKukatpally.storeId).toBe(b.stores.kkp);
  });
});

describe('PUT /estimates/:id', () => {
  it('replaces the surfaces and options and clears what the estimator computed', async () => {
    const created = await create();
    await withTenant(t.connection.db, b.organizationId, (tx) =>
      tx.execute(sql`update estimate_options set litres = 23.625, total_paise = 1180000,
        lines = ${JSON.stringify([
          {
            purpose: 'paint',
            variantId: b.apex,
            sku: 'APX-1L',
            description: 'Apex Ultima 1 l',
            quantity: 24,
            unitPricePaise: 11_800,
            totalPaise: 283_200,
          },
        ])}::jsonb, computed_at = now()
        where estimate_id = ${created.id} and tier = 'good'`),
    );
    const computed = ok(await owner().get(`/estimates/${created.id}`)).json<EstimateView>();
    expect(computed.options[0]?.result).toEqual({
      litres: 23.625,
      lines: [expect.objectContaining({ purpose: 'paint', quantity: 24, totalPaise: 283_200 })],
      totalPaise: 1_180_000,
      computedAt: expect.any(String),
    });

    const updated = ok(
      await owner().put(`/estimates/${created.id}`, {
        storeId: b.stores.amp,
        surfaces: [{ room: 'Terrace', kind: 'exterior', areaSqft: 800, condition: 'repaint' }],
        options: [{ tier: 'better', productId: apex }],
      }),
    ).json<EstimateView>();
    expect(updated).toMatchObject({
      id: created.id,
      number: created.number,
      party: null,
      title: null,
      totalNetAreaSqft: 800,
      surfaces: [expect.objectContaining({ room: 'Terrace', position: 1 })],
      options: [expect.objectContaining({ tier: 'better', result: null })],
    });
    expect(updated.updatedAt >= created.updatedAt).toBe(true);
  });

  it('is final once converted into a quotation', async () => {
    const created = await create();
    const quotation = ok(
      await owner().post('/quotations', {
        storeId: b.stores.amp,
        billToPartyId: b.parties.homeowner,
        lines: [{ variantId: b.apex, quantity: 24 }],
      }),
    ).json<QuotationView>();
    // What the estimator's convert (round 5b) records.
    await withTenant(t.connection.db, b.organizationId, (tx) =>
      tx.execute(sql`update estimates set status = 'converted', quotation_id = ${quotation.id},
        converted_tier = 'good', converted_at = now() where id = ${created.id}`),
    );
    const converted = ok(await owner().get(`/estimates/${created.id}`)).json<EstimateView>();
    expect(converted).toMatchObject({
      status: 'converted',
      quotationId: quotation.id,
      quotationNumber: quotation.number,
      convertedTier: 'good',
      convertedAt: expect.any(String),
    });
    const changed = await owner().put(`/estimates/${created.id}`, body());
    expect(changed.statusCode).toBe(409);
    expect(changed.json<{ message: string }>().message).toBe(
      'This estimate became a quotation: change the quotation instead',
    );
    expect((await owner().delete(`/estimates/${created.id}`)).statusCode).toBe(409);
  });
});

describe('DELETE /estimates/:id', () => {
  it('discards a draft', async () => {
    const created = await create();
    expect((await owner().delete(`/estimates/${created.id}`)).statusCode).toBe(204);
    expect((await owner().get(`/estimates/${created.id}`)).statusCode).toBe(404);
    expect((await owner().delete(`/estimates/${created.id}`)).statusCode).toBe(404);
  });
});

describe('GET /estimates', () => {
  it('lists newest first at the member’s stores, by store, customer, site, status or text', async () => {
    const fresh = await billingBusiness(t);
    const o = api(t, fresh.owner);
    const surfaces = [
      {
        room: 'Hall',
        kind: 'interior_wall',
        areaSqft: 100,
        openingsSqft: 20,
        condition: 'repaint',
      },
    ];
    const at = async (storeId: string, extra: object = {}) =>
      ok(await o.post('/estimates', { storeId, surfaces, ...extra })).json<EstimateView>();
    const first = await at(fresh.stores.amp, {
      partyId: fresh.parties.homeowner,
      title: 'Hall only',
    });
    const second = await at(fresh.stores.kkp, { partyId: fresh.parties.contractor });
    const third = await at(fresh.stores.amp);

    const list = async (query: string, token = fresh.owner) =>
      ok(await api(t, token).get(`/estimates?${query}`)).json<EstimatePage>();
    const all = await list('');
    expect(all.total).toBe(3);
    expect(all.items.map((item) => item.id)).toEqual([third.id, second.id, first.id]);
    expect(all.items[2]).toEqual({
      id: first.id,
      number: first.number,
      status: 'draft',
      storeId: fresh.stores.amp,
      partyId: fresh.parties.homeowner,
      partyName: 'Suresh',
      projectId: null,
      title: 'Hall only',
      totalNetAreaSqft: 80,
      quotationId: null,
      createdAt: first.createdAt,
    });
    expect((await list(`storeId=${fresh.stores.kkp}`)).items.map((item) => item.id)).toEqual([
      second.id,
    ]);
    expect((await list(`partyId=${fresh.parties.homeowner}`)).total).toBe(1);
    expect((await list(`projectId=${site}`)).total).toBe(0);
    expect((await list('status=converted')).total).toBe(0);
    expect((await list('q=hall')).items.map((item) => item.id)).toEqual([first.id]);
    expect((await list('q=deccan')).items.map((item) => item.id)).toEqual([second.id]);
    expect((await list(`q=${first.number}`)).total).toBe(1);
    expect(await list('limit=1&offset=1')).toMatchObject({ total: 3, items: [{ id: second.id }] });

    // A Kukatpally salesperson sees Kukatpally's estimates only.
    const kukatpally = await fresh.member('sales_executive', [fresh.stores.kkp]);
    expect((await list('', kukatpally)).items.map((item) => item.id)).toEqual([second.id]);
    expect((await api(t, kukatpally).get(`/estimates/${first.id}`)).statusCode).toBe(404);
    // A store employee reads estimates (sales:read) but does not write them.
    const employee = await fresh.member('store_employee', [fresh.stores.amp]);
    expect((await list('', employee)).total).toBe(2);
    expect((await api(t, employee).delete(`/estimates/${first.id}`)).statusCode).toBe(403);
  });
});
