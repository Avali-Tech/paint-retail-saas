import { migrateDatabase, schema } from '@paint/db';
import type {
  InvoiceDispatchesView,
  IssuedInvoiceView,
  SalesOrderView,
  TaxCategoryOptions,
  TaxDocumentView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  issuesOf,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';

// Round 8a: the colorant in a tinted pack leaves stock with the pack.

const { creditProfiles, stockBalances, stockLedger } = schema;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
/** Loose colorants: "XY" stocked by the ml, "Fast Red" by the g. */
let xy: string;
let red: string;
/** A colorant sold by the litre can: not loose, so it cannot be dosed. */
let xyCan: string;
/** A loose colorant this store has never stocked. */
let blue: string;

const owner = () => api(t, b.owner);

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  const o = owner();
  const apex = ok(await o.get('/products?q=Apex')).json<{
    items: { id: string; brand: { id: string } }[];
  }>().items[0];
  ok(await o.patch(`/products/${String(apex?.id)}`, { isTintable: true }));
  const taxCategoryId = String(
    ok(await o.get('/tax-categories/options'))
      .json<TaxCategoryOptions>()
      .categories.find((category) => category.key === 'paints')?.id,
  );
  const colorants = ok(
    await o.post('/products', {
      brandId: String(apex?.brand.id),
      name: 'Universal colorant',
      type: 'colorant',
      hsnCode: '32129090',
      taxCategoryId,
      variants: [
        { sku: 'CLR-XY-ML', packSize: 1, unit: 'ml', densityGPerMl: 1.6 },
        { sku: 'CLR-RED-G', packSize: 1, unit: 'g', densityGPerMl: 1.25, label: 'Fast Red' },
        { sku: 'CLR-XY-1L', packSize: 1, unit: 'l' },
        { sku: 'CLR-BLUE-ML', packSize: 1, unit: 'ml', label: 'Blue' },
      ],
    }),
  ).json<{ variants: { id: string; sku: string }[] }>().variants;
  const id = (sku: string) => String(colorants.find((variant) => variant.sku === sku)?.id);
  [xy, red, xyCan, blue] = [id('CLR-XY-ML'), id('CLR-RED-G'), id('CLR-XY-1L'), id('CLR-BLUE-ML')];
  ok(
    await o.post('/stock/movements', {
      storeId: b.stores.amp,
      type: 'opening',
      lines: [
        { variantId: xy, quantity: 100 },
        { variantId: red, quantity: 5 },
      ],
    }),
  );
  // One shot of the machine is half a ml.
  ok(await o.put('/sales/settings', { tintShotMl: 0.5 }));
  await t.connection.db.insert(creditProfiles).values({
    organizationId: b.organizationId,
    partyId: b.parties.contractor,
    status: 'active',
    limitPaise: 1_000_000_000,
    creditDays: 15,
  });
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

/** XY 10 ml and Fast Red 4 shots a pack: 2 packs take 20 ml of XY and 5 g of red (4 × 0.5 ml × 1.25). */
const FORMULA = () => [
  { colorant: 'XY', amount: 10, unit: 'ml', colorantVariantId: xy },
  { colorant: 'Fast Red', amount: 4, unit: 'shot', colorantVariantId: red },
];

async function stockOf(variantId: string): Promise<number> {
  const [row] = await t.connection.db
    .select({ onHand: stockBalances.onHand })
    .from(stockBalances)
    .where(and(eq(stockBalances.storeId, b.stores.amp), eq(stockBalances.variantId, variantId)));
  return row?.onHand ?? 0;
}

async function setStock(variantId: string, onHand: number): Promise<void> {
  const now = await stockOf(variantId);
  if (now === onHand) return;
  ok(
    await owner().post('/stock/movements', {
      storeId: b.stores.amp,
      type: 'adjustment',
      note: 'Test count',
      lines: [{ variantId, quantity: onHand - now }],
    }),
  );
}

const lastUse = async (variantId: string) =>
  (
    await t.connection.db
      .select({
        quantity: stockLedger.quantity,
        note: stockLedger.note,
        referenceType: stockLedger.referenceType,
        referenceId: stockLedger.referenceId,
      })
      .from(stockLedger)
      .where(and(eq(stockLedger.variantId, variantId), eq(stockLedger.movementType, 'tint_use')))
      .orderBy(desc(stockLedger.createdAt))
      .limit(1)
  )[0];

const shortNotices = async () =>
  (await owner().get('/notifications'))
    .json<{ items: { event: string; title: string; body: string; link: string }[] }>()
    .items.filter((notice) => notice.event === 'colorant_short');

/** A bill of 2 tinted packs to the contractor, issued. */
async function issuedTinted(formula: object[], quantity = 2): Promise<IssuedInvoiceView> {
  const draft = await b.draft({
    partyId: b.parties.contractor,
    lines: [{ variantId: b.apex, quantity, tint: { shadeCode: 'X 132', formula } }],
  });
  // On the contractor's account.
  return ok(await owner().post(`/invoices/${draft.id}/issue`, {})).json<IssuedInvoiceView>();
}

describe('colorant leaves stock with the tinted packs', () => {
  it('takes each dose, in the colorant’s own unit, when the bill is issued', async () => {
    await setStock(xy, 100);
    await setStock(red, 5);
    const invoice = await issuedTinted(FORMULA());

    expect([await stockOf(xy), await stockOf(red)]).toEqual([80, 0]);
    expect(await lastUse(xy)).toEqual({
      quantity: -20,
      note: `Tinting for ${String(invoice.number)}`,
      referenceType: 'tax_document',
      referenceId: invoice.id,
    });
    expect((await lastUse(red))?.quantity).toBe(-5);
    expect(await shortNotices()).toEqual([]);
  });

  it('never stops the bill when the store is short: takes what is there and says so', async () => {
    await setStock(xy, 100);
    await setStock(red, 3);
    const invoice = await issuedTinted(FORMULA());

    // 3 g of the 5 g taken; the movement notes the 2 g short.
    expect([await stockOf(xy), await stockOf(red)]).toEqual([80, 0]);
    expect((await lastUse(red))?.note).toBe(`Tinting for ${String(invoice.number)}, short by 2 g`);
    const [notice] = await shortNotices();
    expect(notice).toMatchObject({
      event: 'colorant_short',
      title: `Colorant not fully taken for ${String(invoice.number)}`,
      body: 'Universal colorant (CLR-RED-G) short by 2 g: 3 of 5 taken. Record the colorant received, or count it.',
      link: `/invoices/${invoice.id}`,
    });

    // None left at all: nothing to take, but still told.
    const next = await issuedTinted(FORMULA());
    expect(await stockOf(red)).toBe(0);
    expect((await shortNotices())[0]?.body).toBe(
      'Universal colorant (CLR-RED-G) short by 5 g: 0 of 5 taken. Record the colorant received, or count it.',
    );
    expect((await shortNotices())[0]?.link).toBe(`/invoices/${next.id}`);
  });

  it('says what is missing when a dose cannot be worked out, and still bills', async () => {
    await setStock(xy, 100);
    const before = (await shortNotices()).length;
    // No Y size is set.
    const invoice = await issuedTinted([
      { colorant: 'XY', amount: 6, unit: 'y', colorantVariantId: xy },
    ]);
    expect(await stockOf(xy)).toBe(100);
    const notices = await shortNotices();
    expect(notices).toHaveLength(before + 1);
    expect(notices[0]?.body).toBe(
      'Universal colorant (CLR-XY-ML) not taken: set how many ml a Y is (Settings → Tinting). Record the colorant received, or count it.',
    );
    expect(notices[0]?.title).toContain(String(invoice.number));
  });

  it('takes nothing for a dose that names no colorant', async () => {
    await setStock(xy, 100);
    await issuedTinted([{ colorant: 'XY', amount: 10, unit: 'ml' }]);
    expect(await stockOf(xy)).toBe(100);
  });

  it('tells the store about a colorant it has never stocked', async () => {
    const invoice = await issuedTinted([
      { colorant: 'Blue', amount: 2, unit: 'ml', colorantVariantId: blue },
    ]);
    const [notice] = await shortNotices();
    expect(notice?.body).toBe(
      'Universal colorant (CLR-BLUE-ML) short by 4 ml: 0 of 4 taken. Record the colorant received, or count it.',
    );
    expect(notice?.link).toBe(`/invoices/${invoice.id}`);
  });

  it('takes only the doses that name a colorant, line by line', async () => {
    await setStock(xy, 100);
    const draft = await b.draft({
      partyId: b.parties.contractor,
      lines: [
        // Tinted with no formula recorded.
        { variantId: b.apex, quantity: 1, tint: { shadeCode: 'X 132' } },
        {
          variantId: b.apex,
          quantity: 1,
          tint: {
            shadeCode: 'X 140',
            formula: [
              { colorant: 'Black', amount: 3, unit: 'ml' },
              { colorant: 'XY', amount: 7, unit: 'ml', colorantVariantId: xy },
            ],
          },
        },
      ],
    });
    ok(await owner().post(`/invoices/${draft.id}/issue`, {}));
    expect(await stockOf(xy)).toBe(93);
  });
});

describe('colorant on dispatch (stock out as the goods leave)', () => {
  it('takes the dose of the packs that leave, dispatch by dispatch', async () => {
    await setStock(xy, 100);
    ok(await owner().put('/sales/settings', { stockPostOn: 'dispatch' }));
    try {
      const order = ok(
        await owner().post('/sales-orders', {
          storeId: b.stores.amp,
          billToPartyId: b.parties.contractor,
          paymentTerms: 'postpaid',
          lines: [
            {
              variantId: b.apex,
              quantity: 2,
              tint: {
                shadeCode: 'X 132',
                formula: [{ colorant: 'XY', amount: 10, unit: 'ml', colorantVariantId: xy }],
              },
            },
          ],
        }),
      ).json<SalesOrderView>();
      const confirmed = ok(
        await owner().post(`/sales-orders/${order.id}/confirm`, {}),
      ).json<SalesOrderView>();
      const draft = ok(
        await owner().post(`/sales-orders/${order.id}/invoices`, {
          lines: [{ orderLineId: confirmed.lines[0]?.id, quantity: 2 }],
        }),
      ).json<TaxDocumentView>();
      const invoice = ok(
        await owner().post(`/invoices/${draft.id}/issue`, {}),
      ).json<IssuedInvoiceView>();
      // Billed now, nothing has left yet.
      expect(await stockOf(xy)).toBe(100);

      const line = String(invoice.lines[0]?.id);
      const first = ok(
        await owner().post(`/invoices/${invoice.id}/dispatches`, {
          lines: [{ invoiceLineId: line, quantity: 1 }],
        }),
      ).json<{ id: string }>();
      expect(await stockOf(xy)).toBe(90);
      expect(await lastUse(xy)).toMatchObject({ referenceType: 'dispatch', referenceId: first.id });
      ok(await owner().post(`/invoices/${invoice.id}/dispatches`, {}));
      expect(await stockOf(xy)).toBe(80);
      const sent = ok(
        await owner().get(`/invoices/${invoice.id}/dispatches`),
      ).json<InvoiceDispatchesView>();
      expect(sent.dispatches).toHaveLength(2);
    } finally {
      ok(await owner().put('/sales/settings', { stockPostOn: 'invoice' }));
    }
  });
});

describe('a dose names a loose colorant', () => {
  it('refuses a product that is not a colorant, or a colorant sold by the can', async () => {
    // Not a colorant, a colorant by the can, and an unknown product.
    for (const colorantVariantId of [b.apex, xyCan, '00000000-0000-4000-8000-000000000000']) {
      const refused = await api(t, b.owner).post('/invoices', {
        storeId: b.stores.amp,
        lines: [
          {
            variantId: b.apex,
            quantity: 1,
            tint: {
              shadeCode: 'X 132',
              formula: [{ colorant: 'XY', amount: 10, unit: 'ml', colorantVariantId }],
            },
          },
        ],
      });
      expect(refused.statusCode).toBe(400);
      expect(issuesOf(refused)).toEqual(['lines.0.tint.formula.0.colorantVariantId']);
    }
  });
});

describe('the tinting machine’s units', () => {
  it('keeps the ml of a shot and a Y, and clears them', async () => {
    const saved = ok(
      await owner().put('/sales/settings', { tintShotMl: 0.616, tintYMl: 0.308 }),
    ).json<{ tintShotMl: number | null; tintYMl: number | null }>();
    expect([saved.tintShotMl, saved.tintYMl]).toEqual([0.616, 0.308]);
    expect(issuesOf(await owner().put('/sales/settings', { tintYMl: 0.12345 }))).toEqual([
      'tintYMl',
    ]);
    expect(issuesOf(await owner().put('/sales/settings', { tintShotMl: 0 }))).toEqual([
      'tintShotMl',
    ]);
    const cleared = ok(
      await owner().put('/sales/settings', { tintShotMl: 0.5, tintYMl: null }),
    ).json<{ tintShotMl: number | null; tintYMl: number | null }>();
    expect([cleared.tintShotMl, cleared.tintYMl]).toEqual([0.5, null]);
  });
});
