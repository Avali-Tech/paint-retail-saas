import { migrateDatabase, postStockMovements, schema, withTenant } from '@paint/db';
import {
  planStockUp,
  type BenefitReceiptView,
  type BrandClaimView,
  type PriceHikePlanView,
  type SchemeClaimsReport,
  type SchemeDetail,
  type SchemeSummary,
  type SchemesOverview,
  type SchemeView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { indiaToday } from '../billing/invoice-view.js';
import { api, ok } from '../test-support/billing-business.js';
import { istDate } from '../test-support/business.js';
import { seedSchemeBusiness, type SchemeBusiness } from '../test-support/scheme-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';

// Brand schemes, targets and rebates (P2-M33, round 5a): schemes and slabs checked like
// the engine, progress from the brand's GRNs, what the brand issued, claims and their
// age, the price-hike planner and the CSV reports.

let database: TestDatabase;
let t: TestApp;
let biz: SchemeBusiness;

const owner = () => api(t, biz.owner);

/** Monsoon slab: Apex, July–September by value, retro, settled 30 days after. */
const monsoon = () => ({
  brandId: biz.brands.apex,
  name: 'Monsoon slab',
  brandReference: 'APX/Q2/26',
  startsOn: '2026-07-01',
  endsOn: '2026-09-30',
  measure: 'value',
  mode: 'retro',
  settlementDays: 30,
  dateBasis: 'grn_date',
  note: 'Circular of 28 June',
  productIds: [],
  categoryIds: [],
  slabs: [
    {
      target: 50_000_00,
      benefits: [
        { kind: 'rebate', basisPoints: 100 },
        { kind: 'points', label: 'Goa trip', points: 1 },
      ],
    },
    {
      target: 1_00_000_00,
      benefits: [
        { kind: 'rebate', basisPoints: 200 },
        { kind: 'free_goods', variantId: biz.variants.ultima10, units: 1, perMillilitres: 100_000 },
      ],
    },
  ],
});

let monsoonId: string;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  biz = await seedSchemeBusiness(t);
  monsoonId = ok(await owner().post('/brand-schemes', monsoon())).json<SchemeView>().id;
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('who may see and change schemes', () => {
  it('lets purchasing see schemes, only owners and admins change them, and nobody else in', async () => {
    const buyer = api(t, biz.buyer);
    expect((await buyer.get('/brand-schemes')).statusCode).toBe(200);
    expect((await buyer.get(`/brand-schemes/${monsoonId}`)).statusCode).toBe(200);
    expect((await buyer.post('/brand-schemes', monsoon())).statusCode).toBe(403);
    expect((await buyer.post(`/brand-schemes/${monsoonId}/activate`)).statusCode).toBe(403);
    const cashier = api(t, biz.cashier);
    for (const path of ['/brand-schemes', '/brand-schemes/overview', '/brand-schemes/claims']) {
      expect((await cashier.get(path)).statusCode).toBe(403);
      expect((await buyer.get(path)).statusCode).toBe(200);
    }
  });
});

describe('entering a scheme', () => {
  it('stores the scheme with its slabs and benefits, as a draft', async () => {
    const scheme = ok(await owner().get(`/brand-schemes/${monsoonId}`)).json<SchemeDetail>().scheme;
    expect(scheme).toMatchObject({
      brand: { id: biz.brands.apex, name: 'Apex Paints' },
      name: 'Monsoon slab',
      brandReference: 'APX/Q2/26',
      status: 'draft',
      measure: 'value',
      mode: 'retro',
      settlementDays: 30,
      dateBasis: 'grn_date',
      products: [],
      categories: [],
      endedAt: null,
    });
    expect(scheme.slabs.map((slab) => [slab.position, slab.target])).toEqual([
      [1, 50_000_00],
      [2, 1_00_000_00],
    ]);
    expect(scheme.slabs[1]?.benefits).toEqual([
      { kind: 'rebate', basisPoints: 200 },
      {
        kind: 'free_goods',
        variantId: biz.variants.ultima10,
        units: 1,
        perMillilitres: 100_000,
        variantTitle: 'Apex Paints Ultima 10 l',
      },
    ]);
  });

  it('refuses what the engine would refuse, and what is not of the business or the brand', async () => {
    const post = (changes: object) => owner().post('/brand-schemes', { ...monsoon(), ...changes });
    const falling = await post({
      name: 'Falling',
      slabs: [
        { target: 2_000, benefits: [{ kind: 'rebate', basisPoints: 100 }] },
        { target: 1_000, benefits: [{ kind: 'rebate', basisPoints: 200 }] },
      ],
    });
    expect(falling.statusCode).toBe(400);
    expect(falling.json<{ message: string }>().message).toMatch(/above the one before/);
    // [PO-31]: an incremental rupee scheme cannot pay per litre.
    const mixed = await post({
      name: 'Mixed',
      mode: 'incremental',
      slabs: [{ target: 1_000, benefits: [{ kind: 'per_litre', paisePerLitre: 200 }] }],
    });
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json<{ message: string }>().message).toMatch(/incremental value scheme.*retro/);
    expect((await post({ name: 'Other brand', productIds: [biz.products.silk] })).statusCode).toBe(
      400,
    );
    expect(
      (await post({ name: 'No category', categoryIds: ['00000000-0000-4000-8000-000000000009'] }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await post({
          name: 'No pack',
          slabs: [
            {
              target: 1_000,
              benefits: [
                {
                  kind: 'free_goods',
                  variantId: '00000000-0000-4000-8000-000000000009',
                  units: 1,
                },
              ],
            },
          ],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await post({ name: 'No brand', brandId: '00000000-0000-4000-8000-000000000009' }))
        .statusCode,
    ).toBe(404);
    expect((await post({ name: 'MONSOON SLAB' })).statusCode).toBe(409);
    expect((await post({ name: 'Backwards', endsOn: '2026-06-30' })).statusCode).toBe(400);
    expect((await post({ name: 'No slabs', slabs: [] })).statusCode).toBe(400);
  });

  it('keeps a scheme on its products and categories, de-duplicated', async () => {
    const created = ok(
      await owner().post('/brand-schemes', {
        ...monsoon(),
        name: 'Ultima and emulsions',
        productIds: [biz.products.ultima, biz.products.ultima],
        categoryIds: [biz.categories.emulsions],
      }),
    ).json<SchemeView>();
    expect(created.products).toEqual([{ id: biz.products.ultima, name: 'Apex Paints Ultima' }]);
    expect(created.categories).toEqual([{ id: biz.categories.emulsions, name: 'Emulsions' }]);
  });
});

describe('progress from GRNs', () => {
  it('counts the brand’s GRN lines by GRN date: current and next slab, per day needed, projection', async () => {
    const detail = ok(
      await owner().get(`/brand-schemes/${monsoonId}?asOf=2026-08-15`),
    ).json<SchemeDetail>();
    expect(detail.progress).toMatchObject({
      asOf: '2026-08-15',
      achievedValuePaise: 60_000_00,
      achievedMillilitres: 280_000,
      freeMillilitres: 20_000,
      achieved: 60_000_00,
      current: { index: 0, target: 50_000_00 },
      next: { index: 1, target: 1_00_000_00, distance: 40_000_00, perDayNeeded: 86_957 },
      periodDays: 92,
      elapsedDays: 46,
      remainingDays: 46,
      projected: 1_20_000_00,
      projectedSlab: { index: 1 },
    });
    expect(detail.progress.benefit).toEqual({
      rebatePaise: 600_00,
      perLitrePaise: 0,
      creditPaise: 600_00,
      freeGoods: [],
      points: [{ label: 'Goa trip', points: 1 }],
    });
    expect(detail.progress.projectedBenefit.freeGoods).toEqual([
      { variantId: biz.variants.ultima10, units: 5 },
    ]);
    // The GRNs counted, scheme-free units flagged; Berger's and October's are not.
    expect(
      detail.grnLines.map((line) => [
        line.number,
        line.countedOn,
        line.store.code,
        line.sku,
        line.quantity,
        line.freeQuantity,
        line.valuePaise,
        line.millilitres,
        line.freeMillilitres,
      ]),
    ).toEqual([
      ['GRN-000001', '2026-07-10', 'HYD', 'ULT-20L', 10, 1, 40_000_00, 200_000, 20_000],
      ['GRN-000002', '2026-07-15', 'HYD', 'PUT-40KG', 10, 0, 5_000_00, 0, 0],
      ['GRN-000003', '2026-08-05', 'SEC', 'ULT-10L', 6, 0, 15_000_00, 60_000, 0],
    ]);
    expect(detail.grnLines[0]).toMatchObject({
      kind: 'receipt',
      supplierName: 'Deccan Distributors',
      supplierInvoiceDate: '2026-07-09',
      productName: 'Apex Paints Ultima',
      unitCostPaise: 4_000_00,
    });
  });

  it('counts by the supplier invoice date when the scheme says so, the GRN date without one ([CA-21])', async () => {
    const changed = ok(
      await owner().put(`/brand-schemes/${monsoonId}`, { ...monsoon(), dateBasis: 'invoice_date' }),
    ).json<SchemeView>();
    expect(changed.dateBasis).toBe('invoice_date');
    const detail = ok(
      await owner().get(`/brand-schemes/${monsoonId}?asOf=2026-10-15`),
    ).json<SchemeDetail>();
    // AD/102 was invoiced on 28 June: before the period. The putty has no invoice date.
    expect(detail.grnLines.map((line) => [line.number, line.countedOn])).toEqual([
      ['GRN-000001', '2026-07-09'],
      ['GRN-000002', '2026-07-15'],
    ]);
    expect(detail.progress.achieved).toBe(45_000_00);
    expect(detail.progress.current).toBeNull();
    ok(await owner().put(`/brand-schemes/${monsoonId}`, monsoon()));
  });

  it('shows a member only the GRN lines of their stores, with the business’s totals', async () => {
    const detail = ok(
      await api(t, biz.buyer).get(`/brand-schemes/${monsoonId}?asOf=2026-08-15`),
    ).json<SchemeDetail>();
    expect(detail.grnLines.map((line) => line.store.code)).toEqual(['HYD', 'HYD']);
    expect(detail.progress.achieved).toBe(60_000_00);
  });

  it('nets purchase returns, at their GRN’s cost, on the day they went back', async () => {
    const today = await withTenant(t.connection.db, biz.organizationId, (tx) => indiaToday(tx));
    const scheme = ok(
      await owner().post('/brand-schemes', {
        ...monsoon(),
        name: 'This month',
        startsOn: istDate(-1),
        endsOn: istDate(29),
        productIds: [biz.products.ultima],
      }),
    ).json<SchemeView>();
    ok(
      await owner().post('/goods-receipts', {
        storeId: biz.stores.hyd,
        supplierId: biz.supplier,
        supplierInvoiceNumber: 'AD/105',
        lines: [{ variantId: biz.variants.ultima20, quantity: 3, unitCostPaise: 4_000_00 }],
      }),
    );
    await withTenant(t.connection.db, biz.organizationId, (tx) =>
      postStockMovements(tx, [
        {
          organizationId: biz.organizationId,
          storeId: biz.stores.hyd,
          variantId: biz.variants.ultima20,
          movementType: 'purchase_return',
          quantity: -2,
          referenceType: 'goods_receipt',
          referenceId: biz.grns.g1,
          note: 'Damaged tins back to Deccan',
        },
        {
          organizationId: biz.organizationId,
          storeId: biz.stores.hyd,
          variantId: biz.variants.ultima20,
          movementType: 'purchase_return',
          quantity: -1,
          unitCostPaise: 3_900_00,
        },
        // No cost known: it takes litres off, no value.
        {
          organizationId: biz.organizationId,
          storeId: biz.stores.hyd,
          variantId: biz.variants.ultima10,
          movementType: 'purchase_return',
          quantity: -1,
        },
      ]),
    );
    const detail = ok(await owner().get(`/brand-schemes/${scheme.id}`)).json<SchemeDetail>();
    // Movements written together have no order between them: by value.
    const lines = [...detail.grnLines].sort((x, y) => y.valuePaise - x.valuePaise);
    expect(lines.map((line) => [line.kind, line.number, line.countedOn, line.valuePaise])).toEqual([
      ['receipt', 'GRN-000006', today, 12_000_00],
      ['return', 'Purchase return', today, 0],
      ['return', 'Purchase return', today, -3_900_00],
      ['return', 'Damaged tins back to Deccan', today, -8_000_00],
    ]);
    expect(lines[1]).toMatchObject({ unitCostPaise: null, millilitres: -10_000 });
    expect(detail.progress.achievedValuePaise).toBe(100_00);
    expect(detail.progress.achievedMillilitres).toBe(0);
    ok(await owner().post(`/brand-schemes/${scheme.id}/cancel`, { note: 'Test only' }));
  });
});

describe('a scheme’s life', () => {
  it('activates a draft, closes an active scheme and cancels a draft, once each', async () => {
    const draft = ok(
      await owner().post('/brand-schemes', { ...monsoon(), name: 'Short lived' }),
    ).json<SchemeView>();
    expect((await owner().post(`/brand-schemes/${draft.id}/close`, {})).statusCode).toBe(409);
    const cancelled = ok(
      await owner().post(`/brand-schemes/${draft.id}/cancel`, { note: 'Brand withdrew it' }),
    ).json<SchemeView>();
    expect(cancelled).toMatchObject({ status: 'cancelled', endNote: 'Brand withdrew it' });
    expect(cancelled.endedAt).not.toBeNull();
    expect((await owner().post(`/brand-schemes/${draft.id}/cancel`, {})).statusCode).toBe(409);
    expect((await owner().post(`/brand-schemes/${draft.id}/activate`)).statusCode).toBe(409);
    expect(
      (await owner().put(`/brand-schemes/${draft.id}`, { ...monsoon(), name: 'Short lived' }))
        .statusCode,
    ).toBe(409);

    const active = ok(
      await owner().post('/brand-schemes', { ...monsoon(), name: 'Closing' }),
    ).json<SchemeView>();
    ok(await owner().post(`/brand-schemes/${active.id}/activate`));
    expect(
      (
        await owner().put(`/brand-schemes/${active.id}`, {
          ...monsoon(),
          name: 'Closing',
          brandId: biz.brands.berger,
        })
      ).statusCode,
    ).toBe(409);
    // An active scheme can still be corrected.
    const corrected = ok(
      await owner().put(`/brand-schemes/${active.id}`, {
        ...monsoon(),
        name: 'Closing',
        settlementDays: null,
      }),
    ).json<SchemeView>();
    expect(corrected.settlementDays).toBeNull();
    const closed = ok(
      await owner().post(`/brand-schemes/${active.id}/close`, {}),
    ).json<SchemeView>();
    expect(closed).toMatchObject({ status: 'closed', endNote: null });
    expect(
      (await owner().get('/brand-schemes/00000000-0000-4000-8000-000000000009')).statusCode,
    ).toBe(404);
  });

  it('lists schemes with where each stands, filtered by status and brand', async () => {
    ok(await owner().post(`/brand-schemes/${monsoonId}/activate`));
    const active = ok(
      await owner().get(`/brand-schemes?status=active&brandId=${biz.brands.apex}&asOf=2026-08-15`),
    ).json<SchemeSummary[]>();
    expect(active.map((row) => row.scheme.name)).toEqual(['Monsoon slab']);
    expect(active[0]?.progress.next?.distance).toBe(40_000_00);
    const all = ok(await owner().get('/brand-schemes')).json<SchemeSummary[]>();
    expect(all.length).toBeGreaterThan(3);
  });
});

describe('what the brand issued', () => {
  it('records credit notes, reversals, free goods and points, and refuses what cannot be', async () => {
    const receive = (body: object, headers: Record<string, string> = {}) =>
      api(t, biz.owner, headers).post(`/brand-schemes/${monsoonId}/receipts`, body);
    const note = ok(
      await receive(
        {
          kind: 'money',
          receivedOn: '2026-10-10',
          amountPaise: 400_00,
          moneyForm: 'credit_note',
          reference: 'CN-881',
        },
        { 'idempotency-key': 'cn-881' },
      ),
    ).json<BenefitReceiptView>();
    expect(note).toMatchObject({
      kind: 'money',
      amountPaise: 400_00,
      moneyForm: 'credit_note',
      reference: 'CN-881',
      variant: null,
      claim: null,
      recordedBy: 'Suma Owner',
    });
    // The same request again is answered once.
    const again = ok(
      await receive(
        {
          kind: 'money',
          receivedOn: '2026-10-10',
          amountPaise: 400_00,
          moneyForm: 'credit_note',
          reference: 'CN-881',
        },
        { 'idempotency-key': 'cn-881' },
      ),
    ).json<BenefitReceiptView>();
    expect(again.id).toBe(note.id);
    ok(
      await receive({
        kind: 'money',
        receivedOn: '2026-10-12',
        amountPaise: -100_00,
        moneyForm: 'credit_note',
        reference: 'CN-881',
        note: 'Brand reduced it',
      }),
    );
    const goods = ok(
      await receive({
        kind: 'free_goods',
        receivedOn: '2026-10-12',
        variantId: biz.variants.ultima10,
        units: 1,
        goodsReceiptId: biz.grns.g3,
      }),
    ).json<BenefitReceiptView>();
    expect(goods).toMatchObject({
      variant: { id: biz.variants.ultima10, title: 'Apex Paints Ultima 10 l' },
      units: 1,
      goodsReceipt: { id: biz.grns.g3, number: 'GRN-000004' },
    });
    ok(await receive({ kind: 'points', receivedOn: '2026-10-12', label: 'Goa trip', points: 1 }));
    // A free unit counted twice is reversed, with no GRN.
    ok(
      await receive({
        kind: 'free_goods',
        receivedOn: '2026-10-12',
        variantId: biz.variants.ultima10,
        units: 1,
      }),
    );
    ok(
      await receive({
        kind: 'free_goods',
        receivedOn: '2026-10-12',
        variantId: biz.variants.ultima10,
        units: -1,
        note: 'Counted twice',
      }),
    );

    expect(
      (
        await receive({
          kind: 'money',
          receivedOn: istDate(5),
          amountPaise: 1,
          moneyForm: 'payment',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await receive({
          kind: 'free_goods',
          receivedOn: '2026-10-12',
          variantId: biz.variants.ultima10,
          units: 1,
          goodsReceiptId: '00000000-0000-4000-8000-000000000009',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await receive({
          kind: 'free_goods',
          receivedOn: '2026-10-12',
          variantId: '00000000-0000-4000-8000-000000000009',
          units: 1,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await receive({
          kind: 'money',
          receivedOn: '2026-10-12',
          amountPaise: 0,
          moneyForm: 'payment',
        })
      ).statusCode,
    ).toBe(400);
    const draft = ok(
      await owner().post('/brand-schemes', { ...monsoon(), name: 'Draft only' }),
    ).json<SchemeView>();
    expect(
      (
        await owner().post(`/brand-schemes/${draft.id}/receipts`, {
          kind: 'points',
          receivedOn: '2026-10-12',
          label: 'Gift',
          points: 1,
        })
      ).statusCode,
    ).toBe(409);
  });

  it('compares what came with what the slabs earned', async () => {
    const detail = ok(
      await owner().get(`/brand-schemes/${monsoonId}?asOf=2026-10-15`),
    ).json<SchemeDetail>();
    expect(detail.receipts.map((receipt) => receipt.kind)).toEqual([
      'money',
      'money',
      'free_goods',
      'points',
      'free_goods',
      'free_goods',
    ]);
    expect(detail.claim).toMatchObject({
      final: true,
      dueOn: '2026-10-30',
      daysPastDue: -15,
      bucket: 'not_due',
      status: 'open',
      money: { expectedPaise: 600_00, receivedPaise: 300_00, outstandingPaise: 300_00 },
      freeGoods: [
        {
          variantId: biz.variants.ultima10,
          expectedUnits: 0,
          receivedUnits: 1,
          outstandingUnits: -1,
        },
      ],
      points: [{ label: 'Goa trip', expected: 1, received: 1, outstanding: 0 }],
    });
  });
});

describe('claims filed with the brand', () => {
  let claim: BrandClaimView;
  let second: BrandClaimView;

  it('files a claim for what is still owed, numbered SC-', async () => {
    claim = ok(
      await owner().post(`/brand-schemes/${monsoonId}/claims`, {
        filedOn: '2026-10-14',
        brandReference: 'APX-CLM-77',
      }),
    ).json<BrandClaimView>();
    expect(claim).toMatchObject({
      number: 'SC-000001',
      schemeId: monsoonId,
      filedOn: '2026-10-14',
      claimedPaise: 300_00,
      brandReference: 'APX-CLM-77',
      status: 'filed',
      filedBy: 'Suma Owner',
    });
    second = ok(
      await owner().post(`/brand-schemes/${monsoonId}/claims`, {
        filedOn: '2026-10-15',
        claimedPaise: 100_00,
        note: 'Second reminder',
      }),
    ).json<BrandClaimView>();
    expect(second).toMatchObject({ number: 'SC-000002', claimedPaise: 100_00 });
    expect(
      (await owner().post(`/brand-schemes/${monsoonId}/claims`, { filedOn: istDate(3) }))
        .statusCode,
    ).toBe(400);
    const draft = ok(
      await owner().post('/brand-schemes', { ...monsoon(), name: 'Draft claim' }),
    ).json<SchemeView>();
    expect(
      (await owner().post(`/brand-schemes/${draft.id}/claims`, { filedOn: '2026-10-14' }))
        .statusCode,
    ).toBe(409);
  });

  it('follows a claim forward only, and links what the brand paid to it', async () => {
    const status = (body: object) => owner().post(`/brand-schemes/claims/${claim.id}/status`, body);
    const acknowledged = ok(
      await status({ status: 'acknowledged', note: 'Brand confirmed by phone' }),
    ).json<BrandClaimView>();
    expect(acknowledged).toMatchObject({
      status: 'acknowledged',
      note: 'Brand confirmed by phone',
      brandReference: 'APX-CLM-77',
      resolvedAt: null,
    });
    // Acknowledged without a word: the note stays.
    const quiet = ok(
      await owner().post(`/brand-schemes/claims/${second.id}/status`, { status: 'acknowledged' }),
    ).json<BrandClaimView>();
    expect(quiet).toMatchObject({ status: 'acknowledged', note: 'Second reminder' });
    const paid = ok(
      await owner().post(`/brand-schemes/${monsoonId}/receipts`, {
        kind: 'money',
        receivedOn: '2026-10-15',
        amountPaise: 300_00,
        moneyForm: 'payment',
        reference: 'NEFT-5521',
        claimId: claim.id,
      }),
    ).json<BenefitReceiptView>();
    expect(paid.claim).toEqual({ id: claim.id, number: 'SC-000001' });
    const settled = ok(
      await status({ status: 'settled', brandReference: 'APX-CLM-77/F', note: 'Paid by NEFT' }),
    ).json<BrandClaimView>();
    expect(settled).toMatchObject({
      status: 'settled',
      brandReference: 'APX-CLM-77/F',
      resolutionNote: 'Paid by NEFT',
    });
    expect(settled.resolvedAt).not.toBeNull();
    expect((await status({ status: 'rejected' })).statusCode).toBe(409);
    expect((await status({ status: 'filed' })).statusCode).toBe(400);
    expect(
      (
        await owner().post('/brand-schemes/claims/00000000-0000-4000-8000-000000000009/status', {
          status: 'settled',
        })
      ).statusCode,
    ).toBe(404);
    // A claim of another scheme cannot be answered here.
    const other = ok(
      await owner().post('/brand-schemes', { ...monsoon(), name: 'Other claims' }),
    ).json<SchemeView>();
    ok(await owner().post(`/brand-schemes/${other.id}/activate`));
    expect(
      (
        await owner().post(`/brand-schemes/${other.id}/receipts`, {
          kind: 'money',
          receivedOn: '2026-10-15',
          amountPaise: 1_00,
          moneyForm: 'payment',
          claimId: claim.id,
        })
      ).statusCode,
    ).toBe(400);
    ok(await owner().post(`/brand-schemes/${other.id}/cancel`, {}));
  });

  it('lists every active and closed scheme’s claim with its age; closed ones are written off', async () => {
    // A second Apex scheme still owing, overdue on 1 December.
    const august = ok(
      await owner().post('/brand-schemes', {
        ...monsoon(),
        name: 'August booster',
        startsOn: '2026-08-01',
        endsOn: '2026-08-31',
        settlementDays: 0,
        slabs: [{ target: 10_000_00, benefits: [{ kind: 'rebate', basisPoints: 100 }] }],
      }),
    ).json<SchemeView>();
    ok(await owner().post(`/brand-schemes/${august.id}/activate`));
    const report = ok(
      await owner().get(`/brand-schemes/claims?asOf=2026-12-01&brandId=${biz.brands.apex}`),
    ).json<SchemeClaimsReport>();
    const rows = Object.fromEntries(report.rows.map((row) => [row.scheme.name, row]));
    expect(rows['Monsoon slab']?.claim.status).toBe('excess');
    expect(rows['Monsoon slab']?.filed?.number).toBe('SC-000002');
    expect(rows.Closing?.scheme.status).toBe('closed');
    // August: ₹15,000 bought, 1 % = ₹150 owed since 31 August. "Closing" owes ₹600 but is
    // closed, so it is not aged.
    expect(rows['August booster']?.claim).toMatchObject({
      dueOn: '2026-08-31',
      daysPastDue: 92,
      bucket: 'days_90_plus',
      status: 'open',
    });
    expect(rows.Closing?.claim.money.outstandingPaise).toBe(600_00);
    expect(report.ageing).toEqual([
      { bucket: 'not_due', claims: 0, outstandingPaise: 0 },
      { bucket: 'days_0_30', claims: 0, outstandingPaise: 0 },
      { bucket: 'days_31_60', claims: 0, outstandingPaise: 0 },
      { bucket: 'days_61_90', claims: 0, outstandingPaise: 0 },
      { bucket: 'days_90_plus', claims: 1, outstandingPaise: 150_00 },
    ]);
    ok(await owner().post(`/brand-schemes/${august.id}/cancel`, {}));
  });
});

describe('the dashboard tile', () => {
  it('names the running scheme nearest its next slab and what brands still owe', async () => {
    const berger = ok(
      await owner().post('/brand-schemes', {
        ...monsoon(),
        brandId: biz.brands.berger,
        name: 'Berger quarter',
        slabs: [
          { target: 20_000_00, benefits: [{ kind: 'rebate', basisPoints: 150 }] },
          { target: 40_000_00, benefits: [{ kind: 'rebate', basisPoints: 250 }] },
        ],
      }),
    ).json<SchemeView>();
    ok(await owner().post(`/brand-schemes/${berger.id}/activate`));
    const midway = ok(
      await owner().get('/brand-schemes/overview?asOf=2026-08-15'),
    ).json<SchemesOverview>();
    // Berger needs ₹5,000 more of ₹20,000 (25 %); Apex ₹40,000 of ₹1,00,000 (40 %).
    expect(midway).toMatchObject({
      asOf: '2026-08-15',
      activeSchemes: 2,
      nearest: {
        schemeId: berger.id,
        schemeName: 'Berger quarter',
        brandName: 'Berger',
        measure: 'value',
        distance: 5_000_00,
        remainingDays: 46,
      },
      openClaims: 0,
      overdueClaims: 0,
    });
    // On 12 July Apex is 20 % short of its first slab and Berger has bought nothing.
    const early = ok(
      await owner().get('/brand-schemes/overview?asOf=2026-07-12'),
    ).json<SchemesOverview>();
    expect(early.nearest).toMatchObject({ schemeName: 'Monsoon slab', distance: 10_000_00 });
    const before = ok(
      await owner().get('/brand-schemes/overview?asOf=2026-06-15'),
    ).json<SchemesOverview>();
    expect(before.nearest).toBeNull();
    const later = ok(
      await owner().get('/brand-schemes/overview?asOf=2026-12-01'),
    ).json<SchemesOverview>();
    // After the period nothing is running; Berger owes nothing (no slab), Apex is over-paid.
    expect(later).toMatchObject({ nearest: null, outstandingPaise: 0, openClaims: 0 });
    ok(await owner().post(`/brand-schemes/${berger.id}/cancel`, {}));
    const today = ok(await owner().get('/brand-schemes/overview')).json<SchemesOverview>();
    expect(today.activeSchemes).toBe(1);
  });

  it('counts open claims and overdue ones once the period is over', async () => {
    const owed = ok(
      await owner().post('/brand-schemes', {
        ...monsoon(),
        name: 'July litres',
        startsOn: '2026-07-01',
        endsOn: '2026-07-31',
        measure: 'litres',
        settlementDays: 10,
        slabs: [{ target: 100_000, benefits: [{ kind: 'per_litre', paisePerLitre: 500 }] }],
      }),
    ).json<SchemeView>();
    ok(await owner().post(`/brand-schemes/${owed.id}/activate`));
    // 220 L in July at ₹5/L = ₹1,100, due 10 August.
    const overview = ok(
      await owner().get('/brand-schemes/overview?asOf=2026-08-15'),
    ).json<SchemesOverview>();
    // With Monsoon's ₹600 earned so far (not yet due).
    expect(overview).toMatchObject({ outstandingPaise: 1_700_00, openClaims: 1, overdueClaims: 1 });
    // Before its due date the claim is open but not overdue.
    const due = ok(
      await owner().get('/brand-schemes/overview?asOf=2026-08-05'),
    ).json<SchemesOverview>();
    expect(due).toMatchObject({ openClaims: 1, overdueClaims: 0 });
    ok(await owner().post(`/brand-schemes/${owed.id}/cancel`, {}));
  });
});

describe('the price-hike planner', () => {
  it('plans each pack from today’s stock, the sales window and the last cost paid', async () => {
    const today = await withTenant(t.connection.db, biz.organizationId, (tx) => indiaToday(tx));
    // 30 Ultima 20 L sold at HYD in the window, 3 back; a pack with no cost is left out.
    ok(
      await owner().post('/products', {
        brandId: biz.brands.apex,
        name: 'Primer',
        type: 'primer',
        hsnCode: '3209',
        variants: [{ sku: 'PRM-1L', packSize: 1, unit: 'l' }],
      }),
    );
    ok(
      await owner().post('/goods-receipts', {
        storeId: biz.stores.hyd,
        supplierId: biz.supplier,
        supplierInvoiceNumber: 'AD/106',
        lines: [{ variantId: biz.variants.ultima20, quantity: 40, unitCostPaise: 4_100_00 }],
      }),
    );
    await withTenant(t.connection.db, biz.organizationId, (tx) =>
      postStockMovements(tx, [
        {
          organizationId: biz.organizationId,
          storeId: biz.stores.hyd,
          variantId: biz.variants.ultima20,
          movementType: 'sale',
          quantity: -30,
        },
        {
          organizationId: biz.organizationId,
          storeId: biz.stores.hyd,
          variantId: biz.variants.ultima20,
          movementType: 'sale_return',
          quantity: 3,
          unitCostPaise: 4_000_00,
        },
      ]),
    );
    const body = {
      brandId: biz.brands.apex,
      hikeBasisPoints: 500,
      effectiveOn: istDate(10),
    };
    const plan = ok(
      await owner().post('/brand-schemes/price-hike-plan', body),
    ).json<PriceHikePlanView>();
    expect(plan.brand).toEqual({ id: biz.brands.apex, name: 'Apex Paints' });
    expect(plan.withoutCost).toBe(1);
    const ultima20 = plan.skus.find((sku) => sku.sku === 'ULT-20L');
    // 11 + 3 + 40 in, 2 + 1 returned to Deccan, 30 sold, 3 back.
    expect(ultima20).toMatchObject({ unitCostPaise: 4_100_00, stockUnits: 24, soldUnits: 27 });
    expect(plan.skus.map((sku) => sku.sku)).toEqual(['ULT-10L', 'ULT-20L', 'PUT-40KG']);
    // The engine's own plan for the same figures.
    expect(plan.plan).toEqual(
      planStockUp(
        { hikeBasisPoints: 500, effectiveOn: istDate(10) },
        plan.skus.map((sku) => ({
          variantId: sku.variantId,
          unitCostPaise: sku.unitCostPaise,
          stockUnits: sku.stockUnits,
          soldUnits: sku.soldUnits,
          salesWindowDays: 90,
          deadStockRiskBps: null,
        })),
        today,
      ),
    );
    expect(plan.plan.lines[1]?.stockUpUnits).toBeGreaterThan(0);

    // One store, one category, other rates.
    const sec = ok(
      await owner().post('/brand-schemes/price-hike-plan', {
        ...body,
        storeId: biz.stores.sec,
        categoryIds: [biz.categories.emulsions],
        salesWindowDays: 30,
        holdingCostBps: 0,
        costOfMoneyBps: 0,
        deadStockRiskBps: 0,
        maxCoverDays: 60,
      }),
    ).json<PriceHikePlanView>();
    expect(sec.skus.map((sku) => [sku.sku, sku.stockUnits, sku.soldUnits])).toEqual([
      ['ULT-10L', 6, 0],
      ['ULT-20L', 0, 0],
    ]);
    expect(sec.plan.lines[0]?.breakEvenDays).toBeNull();
    // A product, at the buyer's own stores only.
    const buyer = ok(
      await api(t, biz.buyer).post('/brand-schemes/price-hike-plan', {
        ...body,
        productIds: [biz.products.putty],
      }),
    ).json<PriceHikePlanView>();
    expect(buyer.skus.map((sku) => [sku.sku, sku.stockUnits, sku.unitCostPaise])).toEqual([
      ['PUT-40KG', 10, 500_00],
    ]);
    expect(
      (
        await api(t, biz.buyer).post('/brand-schemes/price-hike-plan', {
          ...body,
          storeId: biz.stores.sec,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await owner().post('/brand-schemes/price-hike-plan', {
          ...body,
          brandId: '00000000-0000-4000-8000-000000000009',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('falls back to the average cost in stock when no supplier price is known', async () => {
    const product = ok(
      await owner().post('/products', {
        brandId: biz.brands.berger,
        name: 'Opening only',
        type: 'interior_paint',
        hsnCode: '3209',
        variants: [{ sku: 'OPN-4L', packSize: 4, unit: 'l' }],
      }),
    ).json<{ variants: { id: string }[] }>();
    ok(
      await owner().post('/stock/movements', {
        storeId: biz.stores.hyd,
        type: 'opening',
        lines: [{ variantId: product.variants[0]?.id, quantity: 4, unitCostPaise: 900_00 }],
      }),
    );
    const plan = ok(
      await owner().post('/brand-schemes/price-hike-plan', {
        brandId: biz.brands.berger,
        hikeBasisPoints: 300,
        effectiveOn: istDate(-1),
      }),
    ).json<PriceHikePlanView>();
    expect(plan.skus.find((sku) => sku.sku === 'OPN-4L')?.unitCostPaise).toBe(900_00);
    // The hike is already in force: nothing to stock up.
    expect(plan.plan.stockUpPaise).toBe(0);
  });
});

describe('CSV reports', () => {
  it('exports schemes and their claims through the reports framework', async () => {
    const progress = ok(
      await owner().get('/reports/brand-schemes?asOf=2026-08-15&schemeStatus=active'),
    );
    const rows = progress.json<{ rows: Record<string, unknown>[] }>().rows;
    expect(rows).toEqual([
      expect.objectContaining({
        brand: 'Apex Paints',
        scheme: 'Monsoon slab',
        status: 'active',
        measure: 'value',
        achieved: '60000.00',
        freeLitres: 20,
        currentSlab: 1,
        nextTarget: '100000.00',
        toGo: '40000.00',
        perDay: '869.57',
        daysLeft: 46,
        projected: '120000.00',
        expected: '600.00',
        received: '0.00',
        outstanding: '600.00',
      }),
    ]);
    const litres = ok(await owner().get('/reports/brand-schemes?schemeStatus=cancelled'));
    expect(
      litres
        .json<{ rows: Record<string, unknown>[] }>()
        .rows.find((row) => row.scheme === 'July litres'),
    ).toMatchObject({ measure: 'litres', achieved: 220, currentSlab: 1, nextTarget: null });
    const csv = await owner().get('/reports/brand-scheme-claims?asOf=2026-12-01&format=csv');
    expect(csv.statusCode).toBe(200);
    expect(csv.body.split('\n')[0]).toContain('Brand,Scheme,Scheme status');
    expect(csv.body).toContain('Monsoon slab');
    const claims = ok(await owner().get('/reports/brand-scheme-claims?asOf=2026-12-01'));
    expect(
      claims
        .json<{ rows: Record<string, unknown>[] }>()
        .rows.find((row) => row.scheme === 'Monsoon slab'),
    ).toMatchObject({
      dueOn: '2026-10-30',
      claimStatus: 'excess',
      expected: '600.00',
      received: '600.00',
      outstanding: '0.00',
      freeUnitsOwed: 0,
      pointsOwed: 0,
      filed: 'SC-000002',
      filedStatus: 'acknowledged',
    });
  });
});

describe('scheme rows stay in their business', () => {
  it('hides another business’s scheme', async () => {
    const other = await seedSchemeBusiness(t);
    expect((await api(t, other.owner).get(`/brand-schemes/${monsoonId}`)).statusCode).toBe(404);
    const [row] = await t.connection.db
      .select({ id: schema.brandSchemes.id })
      .from(schema.brandSchemes)
      .where(eq(schema.brandSchemes.id, monsoonId));
    expect(row?.id).toBe(monsoonId);
  });
});
