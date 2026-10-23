import { migrateDatabase } from '@paint/db';
import type { EstimateView, QuotationView, TaxCategoryOptions } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  dbToday,
  issuesOf,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';

// The estimator's endpoints (round 5b): compute prices every option with the pure
// estimator in @paint/shared; convert turns one tier into a quotation through
// round 4a's quotations, in one transaction.

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let tractor: string;
let royale: string;
let primer: string;
let putty: string;
let unpriced: string;
let site: string;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  const o = api(t, b.owner);
  const brandId = ok(await o.post('/brands', { name: 'Berger' })).json<{ id: string }>().id;
  const options = ok(await o.get('/tax-categories/options')).json<TaxCategoryOptions>();
  const paints = String(options.categories.find((category) => category.key === 'paints')?.id);
  const product = async (
    name: string,
    type: string,
    packs: [string, number, string, number | null][],
    extra: object = {},
  ) =>
    ok(
      await o.post('/products', {
        brandId,
        name,
        type,
        hsnCode: '32091090',
        taxCategoryId: paints,
        variants: packs.map(([sku, packSize, unit, sellingPricePaise]) => ({
          sku,
          packSize,
          unit,
          barcodes: [],
          ...(sellingPricePaise === null ? {} : { sellingPricePaise }),
        })),
        ...extra,
      }),
    ).json<{ id: string }>().id;
  tractor = await product(
    'Tractor',
    'interior_paint',
    [
      ['TRC-20L', 20, 'l', 4_000_00],
      ['TRC-10L', 10, 'l', 2_100_00],
      ['TRC-4L', 4, 'l', 900_00],
      ['TRC-1L', 1, 'l', 250_00],
    ],
    { coverageSqftPerLitre: 120, defaultCoats: 2 },
  );
  royale = await product(
    'Royale',
    'interior_paint',
    [
      ['ROY-10L', 10, 'l', 7_500_00],
      ['ROY-1L', 1, 'l', 820_00],
    ],
    { coverageSqftPerLitre: 140, defaultCoats: 2 },
  );
  primer = await product('Primer', 'primer', [['PRM-10L', 10, 'l', 1_500_00]], {
    coverageSqftPerLitre: 135,
  });
  putty = await product('Putty', 'putty', [
    ['PUT-20KG', 20, 'kg', 1_100_00],
    ['PUT-5KG', 5, 'kg', 330_00],
  ]);
  unpriced = await product('Old Emulsion', 'interior_paint', [['OLD-4L', 4, 'l', null]], {
    coverageSqftPerLitre: 110,
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

const owner = (headers: Record<string, string> = {}) => api(t, b.owner, headers);
/** 1,350 sq ft net to repaint (spec §6.2's example), plus a new 100 sq ft wall. */
const surfaces = [
  {
    room: 'Hall',
    kind: 'interior_wall',
    lengthFt: 50,
    heightFt: 10,
    openingsSqft: 40,
    condition: 'repaint',
  },
  { room: 'Bedroom', kind: 'interior_wall', areaSqft: 890, condition: 'repaint' },
];
const estimate = async (extra: object = {}) =>
  ok(
    await owner().post('/estimates', {
      storeId: b.stores.amp,
      partyId: b.parties.homeowner,
      projectId: site,
      surfaces,
      options: [
        { tier: 'good', productId: tractor },
        { tier: 'best', productId: royale, primerProductId: primer, puttyProductId: putty },
      ],
      ...extra,
    }),
  ).json<EstimateView>();
const compute = async (id: string) =>
  ok(await owner().post(`/estimates/${id}/compute`)).json<EstimateView>();

describe('POST /estimates/:id/compute', () => {
  it('prices each tier as the cheapest pack mix that never under-supplies, and stores it', async () => {
    const created = await estimate({
      surfaces: [
        ...surfaces,
        { room: 'Study', kind: 'interior_wall', areaSqft: 100, condition: 'new' },
      ],
    });
    expect(created.options.map((option) => option.result)).toEqual([null, null]);
    const computed = await compute(created.id);
    const [good, best] = computed.options;
    // 1,450 sq ft × 2 coats ÷ 120 × 1.05 = 25.375 L → 20 L + 4 L + 2 × 1 L (₹5,400).
    expect(good?.result).toEqual({
      litres: 25.375,
      lines: [
        {
          purpose: 'paint',
          variantId: expect.any(String),
          sku: 'TRC-20L',
          description: 'Berger Tractor 20 l',
          quantity: 1,
          unitPricePaise: 4_000_00,
          totalPaise: 4_000_00,
        },
        expect.objectContaining({ sku: 'TRC-4L', quantity: 1, totalPaise: 900_00 }),
        expect.objectContaining({ sku: 'TRC-1L', quantity: 2, totalPaise: 500_00 }),
      ],
      totalPaise: 5_400_00,
      computedAt: expect.any(String),
    });
    // Primer and putty only on the new study wall: 0.78 L and 7.35 kg.
    expect(best?.result?.lines.map((line) => [line.purpose, line.sku, line.quantity])).toEqual([
      ['paint', 'ROY-10L', 2],
      ['paint', 'ROY-1L', 2],
      ['primer', 'PRM-10L', 1],
      ['putty', 'PUT-5KG', 2],
    ]);
    expect(best?.result?.litres).toBe(21.75);
    // Stored: a later read has them.
    const read = ok(await owner().get(`/estimates/${created.id}`)).json<EstimateView>();
    expect(read.options.map((option) => option.result?.totalPaise)).toEqual([
      5_400_00,
      best?.result?.totalPaise,
    ]);
  });

  it('keeps an estimate without options as it is', async () => {
    const bare = await estimate({ options: [] });
    expect((await compute(bare.id)).options).toEqual([]);
  });

  it('offers paint sold by the kg through its density', async () => {
    const o = owner();
    const brandId = ok(await o.post('/brands', { name: 'Nerolac' })).json<{ id: string }>().id;
    const options = ok(await o.get('/tax-categories/options')).json<TaxCategoryOptions>();
    const distemper = ok(
      await o.post('/products', {
        brandId,
        name: 'Beauty Distemper',
        type: 'interior_paint',
        hsnCode: '32091090',
        taxCategoryId: options.categories.find((category) => category.key === 'paints')?.id,
        coverageSqftPerLitre: 60,
        defaultCoats: 2,
        // 20 kg at 1.6 g/ml holds 12.5 l.
        variants: [
          {
            sku: 'DST-20KG',
            packSize: 20,
            unit: 'kg',
            sellingPricePaise: 1_200_00,
            densityGPerMl: 1.6,
          },
        ],
      }),
    ).json<{ id: string; variants: { id: string }[] }>();
    const created = await estimate({ options: [{ tier: 'good', productId: distemper.id }] });

    const [good] = (await compute(created.id)).options;
    expect(good?.result?.lines.map((line) => [line.purpose, line.sku])).toEqual([
      ['paint', 'DST-20KG'],
    ]);
    // 1,350 sq ft × 2 coats ÷ 60 = 45 l, with wastage: four 12.5 l packs.
    expect(good?.result?.lines[0]?.quantity).toBe(4);

    // Without a density, a pack by the kg cannot be counted in litres.
    ok(
      await o.patch(`/variants/${String(distemper.variants[0]?.id)}`, {
        densityGPerMl: null,
      }),
    );
    expect((await o.post(`/estimates/${created.id}/compute`)).statusCode).toBe(409);
  });

  it('says which product cannot be priced', async () => {
    const noPacks = await estimate({ options: [{ tier: 'better', productId: unpriced }] });
    const refused = await owner().post(`/estimates/${noPacks.id}/compute`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ message: string }>().message).toBe(
      'Old Emulsion has no pack with a price on sale for the better option',
    );
    const withPrimer = await estimate({
      surfaces: [{ room: 'Gate', kind: 'metal', areaSqft: 40, condition: 'new' }],
      options: [{ tier: 'good', productId: tractor, primerProductId: primer }],
    });
    ok(await owner().patch(`/products/${primer}`, { coverageSqftPerLitre: null }));
    try {
      const noCoverage = await owner().post(`/estimates/${withPrimer.id}/compute`);
      expect(noCoverage.statusCode).toBe(409);
      expect(noCoverage.json<{ message: string }>().message).toBe(
        'Enter the coverage of Primer (sq ft per litre) to estimate the good option',
      );
    } finally {
      ok(await owner().patch(`/products/${primer}`, { coverageSqftPerLitre: 135 }));
    }
  });

  it('is for sales staff at the estimate’s store', async () => {
    const created = await estimate();
    const reader = await b.member('store_employee', [b.stores.amp]);
    expect((await api(t, reader).post(`/estimates/${created.id}/compute`)).statusCode).toBe(403);
    const elsewhere = await b.member('sales_executive', [b.stores.kkp]);
    expect((await api(t, elsewhere).post(`/estimates/${created.id}/compute`)).statusCode).toBe(404);
  });
});

describe('POST /estimates/:id/convert', () => {
  it('turns the chosen tier into a draft quotation, once', async () => {
    const created = await estimate();
    await compute(created.id);
    const headers = { 'idempotency-key': `convert-${created.id}` };
    const first = ok(
      await owner(headers).post(`/estimates/${created.id}/convert`, {
        tier: 'good',
        note: 'Two coats, walls only',
      }),
    );
    const quotation = first.json<QuotationView>();
    expect(quotation).toMatchObject({
      number: expect.stringMatching(/^QT-\d{6}$/),
      status: 'draft',
      storeId: b.stores.amp,
      billTo: expect.objectContaining({ id: b.parties.homeowner }),
      project: expect.objectContaining({ id: site }),
      note: 'Two coats, walls only',
    });
    // 1,350 sq ft → 23.625 L → 20 L + 4 L, never 20 L + 4 × 1 L.
    expect(quotation.lines.map((line) => [line.sku, line.quantity, line.unitPricePaise])).toEqual([
      ['TRC-20L', 1, 4_000_00],
      ['TRC-4L', 1, 900_00],
    ]);
    const converted = ok(await owner().get(`/estimates/${created.id}`)).json<EstimateView>();
    expect(converted).toMatchObject({
      status: 'converted',
      quotationId: quotation.id,
      quotationNumber: quotation.number,
      convertedTier: 'good',
      convertedAt: expect.any(String),
    });
    // A retry with the same key answers the same quotation; another convert is refused.
    const again = ok(
      await owner(headers).post(`/estimates/${created.id}/convert`, {
        tier: 'good',
        note: 'Two coats, walls only',
      }),
    );
    expect(again.json<QuotationView>().id).toBe(quotation.id);
    const second = await owner().post(`/estimates/${created.id}/convert`, { tier: 'best' });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ message: string }>().message).toBe(
      'This estimate became a quotation: change the quotation instead',
    );
    expect((await owner().post(`/estimates/${created.id}/compute`)).statusCode).toBe(409);
  });

  it('takes the validity asked for, and leaves the estimate a draft when the quotation is refused', async () => {
    const created = await estimate({ projectId: undefined });
    await compute(created.id);
    const yesterday = await dbToday(t, -1);
    const refused = await owner().post(`/estimates/${created.id}/convert`, {
      tier: 'best',
      validUntil: yesterday,
    });
    expect(refused.statusCode).toBe(400);
    expect(issuesOf(refused)).toEqual(['validUntil']);
    expect(ok(await owner().get(`/estimates/${created.id}`)).json<EstimateView>().status).toBe(
      'draft',
    );
    const validUntil = await dbToday(t, 30);
    const quotation = ok(
      await owner().post(`/estimates/${created.id}/convert`, { tier: 'best', validUntil }),
    ).json<QuotationView>();
    expect(quotation.validUntil).toBe(validUntil);
    expect(quotation.project).toBeNull();
    expect(quotation.lines.map((line) => line.sku)).toEqual(['ROY-10L', 'ROY-1L']);
  });

  it('needs a customer, a computed tier that exists, and sales staff at the store', async () => {
    const noCustomer = await estimate({ partyId: undefined, projectId: undefined });
    await compute(noCustomer.id);
    const anonymous = await owner().post(`/estimates/${noCustomer.id}/convert`, { tier: 'good' });
    expect(anonymous.statusCode).toBe(409);
    expect(anonymous.json<{ message: string }>().message).toBe(
      'Choose the customer before making a quotation',
    );

    const created = await estimate();
    const uncomputed = await owner().post(`/estimates/${created.id}/convert`, { tier: 'good' });
    expect(uncomputed.statusCode).toBe(409);
    expect(uncomputed.json<{ message: string }>().message).toBe(
      'Compute the estimate before making a quotation',
    );
    const missing = await owner().post(`/estimates/${created.id}/convert`, { tier: 'better' });
    expect(missing.statusCode).toBe(400);
    expect(issuesOf(missing)).toEqual(['tier']);
    expect(
      issuesOf(await owner().post(`/estimates/${created.id}/convert`, { tier: 'top' })),
    ).toEqual(['tier']);

    await compute(created.id);
    const reader = await b.member('store_employee', [b.stores.amp]);
    const forbidden = await api(t, reader).post(`/estimates/${created.id}/convert`, {
      tier: 'good',
    });
    expect(forbidden.statusCode).toBe(403);
    const elsewhere = await b.member('sales_executive', [b.stores.kkp]);
    expect(
      (await api(t, elsewhere).post(`/estimates/${created.id}/convert`, { tier: 'good' }))
        .statusCode,
    ).toBe(404);
    expect(ok(await owner().get(`/estimates/${created.id}`)).json<EstimateView>().status).toBe(
      'draft',
    );
  });
});
