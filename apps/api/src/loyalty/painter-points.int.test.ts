import { migrateDatabase, postStockMovements, schema, withTenant } from '@paint/db';
import type { EarnRuleView, IssuedInvoiceView, TaxDocumentView } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import {
  api,
  billingBusiness,
  dbToday,
  issuesOf,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import type { ReportPage } from '../reports/reports.service.js';
import {
  earnInfluencerPoints,
  reverseInfluencerPointsForCancel,
  reverseInfluencerPointsForNote,
} from './painter-points.js';
import { PointsNotices } from './points-notice.js';

const { creditProfiles, loyaltyLedger } = schema;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let asianBrand: string;
let bergerBrand: string;
/** Berger 4 L: ₹472 a pack, ₹400 taxable. */
let berger4: string;
/** A painter, a contractor and an architect, each enrolled in loyalty. */
let painter: string;
let contractor: string;
let architect: string;

interface LoyaltyView {
  readonly balance: number;
  readonly painterPoints: { earned: number; takenBack: number };
  readonly ledger: {
    readonly items: {
      kind: string;
      points: number;
      reference: string | null;
      note: string | null;
      expiresOn: string | null;
    }[];
  };
}

const owner = () => api(t, b.owner);
const loyalty = async (partyId: string) =>
  ok(await owner().get(`/parties/${partyId}/loyalty?limit=50`)).json<LoyaltyView>();
const balance = async (partyId: string) => (await loyalty(partyId)).balance;
const issuerOf = async (documentId: string) => {
  const [row] = await t.connection.db
    .select({ memberId: schema.taxDocuments.issuedByMemberId })
    .from(schema.taxDocuments)
    .where(eq(schema.taxDocuments.id, documentId));
  return String(row?.memberId);
};

const rule = (overrides: object = {}) => ({
  name: 'Every brand',
  basis: 'value',
  points: 1,
  perPaise: 10_000,
  perMillilitres: null,
  brandId: null,
  multiplierBps: 10_000,
  validFrom: null,
  validUntil: null,
  isActive: true,
  ...overrides,
});

/** An issued invoice of Apex litres and Berger packs, with an influencer. */
async function sale(
  influencerPartyId: string | null,
  lines: { apex?: number; berger?: number },
  partyId = b.parties.homeowner,
): Promise<IssuedInvoiceView> {
  const draft = await b.draft({
    partyId,
    ...(influencerPartyId === null ? {} : { influencerPartyId }),
    lines: [
      ...(lines.apex ? [{ variantId: b.apex, quantity: lines.apex }] : []),
      ...(lines.berger ? [{ variantId: berger4, quantity: lines.berger }] : []),
    ],
  });
  return ok(await owner().post(`/invoices/${draft.id}/issue`, {})).json<IssuedInvoiceView>();
}

const lineOf = (invoice: IssuedInvoiceView, variantId: string) =>
  String(invoice.lines.find((line) => line.variantId === variantId)?.id);

async function enrolled(displayName: string, roles: string[]): Promise<string> {
  const id = ok(await owner().post('/parties', { displayName, phone: uniquePhone(), roles })).json<{
    id: string;
  }>().id;
  ok(await owner().post(`/parties/${id}/loyalty`, {}));
  return id;
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  const [asian] = await t.connection.db
    .select({ id: schema.brands.id })
    .from(schema.brands)
    .where(eq(schema.brands.organizationId, b.organizationId));
  asianBrand = String(asian?.id);
  bergerBrand = ok(await owner().post('/brands', { name: 'Berger' })).json<{ id: string }>().id;
  const products = ok(await owner().get('/tax-categories/options')).json<{
    categories: { id: string; key: string }[];
  }>();
  const [variant] = ok(
    await owner().post('/products', {
      brandId: bergerBrand,
      name: 'WeatherCoat',
      type: 'exterior_paint',
      hsnCode: '32091090',
      taxCategoryId: products.categories.find((c) => c.key === 'paints')?.id,
      variants: [{ sku: 'BWC-4L', packSize: 4, unit: 'l', sellingPricePaise: 47_200 }],
    }),
  ).json<{ variants: { id: string }[] }>().variants;
  berger4 = String(variant?.id);
  await withTenant(t.connection.db, b.organizationId, (tx) =>
    postStockMovements(tx, [
      {
        organizationId: b.organizationId,
        storeId: b.stores.amp,
        variantId: berger4,
        movementType: 'opening' as const,
        quantity: 1_000,
      },
    ]),
  );
  painter = await enrolled('Ravi Painter', ['painter']);
  contractor = await enrolled('Kiran Contractor', ['contractor']);
  architect = await enrolled('Asha Architect', ['architect']);
  // Bills on account are credit after go-live: the buyers have room.
  for (const partyId of [b.parties.homeowner, b.parties.contractor, painter]) {
    await t.connection.db.insert(creditProfiles).values({
      organizationId: b.organizationId,
      partyId,
      status: 'active',
      limitPaise: 100_000_000,
      creditDays: 30,
    });
  }
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('earn rules', () => {
  it('starts empty, and refuses rules that do not add up', async () => {
    expect(ok(await owner().get('/loyalty-earn-rules')).json()).toEqual([]);
    expect(issuesOf(await owner().post('/loyalty-earn-rules', rule({ perPaise: null })))).toEqual([
      'perPaise',
    ]);
    expect(
      issuesOf(
        await owner().post('/loyalty-earn-rules', rule({ basis: 'litre', perMillilitres: 1000 })),
      ),
    ).toEqual(['perPaise']);
    expect(
      issuesOf(
        await owner().post(
          '/loyalty-earn-rules',
          rule({ validFrom: '2026-10-10', validUntil: '2026-10-01' }),
        ),
      ),
    ).toEqual(['validUntil']);
    expect(
      issuesOf(await owner().post('/loyalty-earn-rules', rule({ brandId: crypto.randomUUID() }))),
    ).toEqual(['brandId']);
  });

  it('lets owners create and change rules; others only read them', async () => {
    const created = ok(await owner().post('/loyalty-earn-rules', rule())).json<EarnRuleView>();
    expect(created).toMatchObject({
      name: 'Every brand',
      basis: 'value',
      perPaise: 10_000,
      perMillilitres: null,
      brand: null,
      isActive: true,
    });
    expect(
      (await owner().post('/loyalty-earn-rules', rule({ name: 'every BRAND' }))).statusCode,
    ).toBe(409);
    const double = ok(
      await owner().post(
        '/loyalty-earn-rules',
        rule({ name: 'Asian double', brandId: asianBrand, multiplierBps: 20_000 }),
      ),
    ).json<EarnRuleView>();
    expect(double.brand).toEqual({ id: asianBrand, name: 'Asian Paints' });

    const manager = await b.member('branch_manager', [b.stores.amp]);
    expect((await api(t, manager).get('/loyalty-earn-rules')).statusCode).toBe(200);
    expect(
      (await api(t, manager).post('/loyalty-earn-rules', rule({ name: 'X' }))).statusCode,
    ).toBe(403);
    expect(
      (await api(t, manager).put(`/loyalty-earn-rules/${created.id}`, rule())).statusCode,
    ).toBe(403);
    const cashier = await b.member('store_employee', [b.stores.amp]);
    expect(
      (await api(t, cashier).post('/loyalty-earn-rules', rule({ name: 'Y' }))).statusCode,
    ).toBe(403);

    // A switched-off rule and a rule out of its dates sit after the active ones.
    const off = ok(
      await owner().post('/loyalty-earn-rules', rule({ name: 'Berger litres', isActive: false })),
    ).json<EarnRuleView>();
    const changed = ok(
      await owner().put(
        `/loyalty-earn-rules/${off.id}`,
        rule({
          name: 'Berger litres',
          basis: 'litre',
          perPaise: null,
          perMillilitres: 1000,
          points: 5,
          brandId: bergerBrand,
          isActive: false,
        }),
      ),
    ).json<EarnRuleView>();
    expect(changed).toMatchObject({ basis: 'litre', perMillilitres: 1000, points: 5 });
    expect(
      (await owner().put(`/loyalty-earn-rules/${crypto.randomUUID()}`, rule({ name: 'Z' })))
        .statusCode,
    ).toBe(404);
    expect(
      (await owner().put(`/loyalty-earn-rules/${off.id}`, rule({ name: 'Asian double' })))
        .statusCode,
    ).toBe(409);
    const list = ok(await owner().get('/loyalty-earn-rules')).json<EarnRuleView[]>();
    expect(list.map((r) => [r.name, r.isActive])).toEqual([
      ['Asian double', true],
      ['Every brand', true],
      ['Berger litres', false],
    ]);
  });
});

describe('painter points on invoices', () => {
  it('earns nothing before go-live', async () => {
    await sale(painter, { apex: 10 });
    expect((await loyalty(painter)).painterPoints).toEqual({ earned: 0, takenBack: 0 });
    ok(await owner().post('/sales/go-live', {}));
  });

  it('earns the influencer points by the best rule per line, and queues the notice', async () => {
    const notices = vi.spyOn(t.app.get(PointsNotices), 'pointsEarned');
    // Apex: ₹1,000 at the Asian double = 20; Berger: ₹400 at every brand = 4.
    const invoice = await sale(painter, { apex: 10, berger: 1 });
    const view = await loyalty(painter);
    expect(view.balance).toBe(24);
    expect(view.painterPoints).toEqual({ earned: 24, takenBack: 0 });
    expect(view.ledger.items[0]).toMatchObject({
      kind: 'influencer',
      points: 24,
      reference: invoice.number,
      expiresOn: null,
    });
    expect(notices).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        partyId: painter,
        partyName: 'Ravi Painter',
        invoiceNumber: invoice.number,
        points: 24,
        balance: 24,
      }),
    );
    notices.mockRestore();
  });

  it('takes back proportionally over returns and credit notes, netting to zero', async () => {
    // The buyer is in the programme too ([PO-7]): both earn on one invoice.
    ok(await owner().post(`/parties/${b.parties.homeowner}/loyalty`, {}));
    const start = await balance(painter);
    const invoice = await sale(painter, { apex: 10, berger: 1 });
    expect(await balance(painter)).toBe(start + 24);
    // The buyer earns the programme's 1 point per ₹100 of ₹1,400.
    expect(await balance(b.parties.homeowner)).toBe(14);

    // Half the Apex back: the Apex line made 20 of 24, half of it is 10.
    ok(
      await owner().post('/sales-returns', {
        invoiceId: invoice.id,
        lines: [{ invoiceLineId: lineOf(invoice, b.apex), quantity: 5, disposition: 'restock' }],
      }),
    );
    expect(await balance(painter)).toBe(start + 14);
    // The buyer's own take-back is unaffected by the painter's on the same note.
    expect(await balance(b.parties.homeowner)).toBe(9);

    // ₹200 of the Berger line credited: 2 of its 4.
    const note = ok(
      await owner().post('/credit-notes', {
        invoiceId: invoice.id,
        reason: 'overcharge',
        lines: [{ invoiceLineId: lineOf(invoice, berger4), valuePaise: 236_00 }],
      }),
    ).json<TaxDocumentView>();
    expect(await balance(painter)).toBe(start + 12);
    expect(await balance(b.parties.homeowner)).toBe(7);
    expect((await loyalty(painter)).ledger.items[0]).toMatchObject({
      kind: 'adjust',
      points: -2,
      reference: note.number,
      note: `Painter points, credit note ${String(note.number)}`,
    });

    // The rest of both lines: exactly what was earned is gone.
    ok(
      await owner().post('/sales-returns', {
        invoiceId: invoice.id,
        lines: [{ invoiceLineId: lineOf(invoice, b.apex), quantity: 5, disposition: 'restock' }],
      }),
    );
    ok(
      await owner().post('/credit-notes', {
        invoiceId: invoice.id,
        reason: 'overcharge',
        lines: [{ invoiceLineId: lineOf(invoice, berger4), valuePaise: 236_00 }],
      }),
    );
    expect(await balance(painter)).toBe(start);
    expect((await loyalty(painter)).painterPoints).toEqual({ earned: 48, takenBack: 24 });

    // Retrying the hook for a note changes nothing.
    const memberId = await issuerOf(invoice.id);
    const again = await withTenant(t.connection.db, b.organizationId, (tx) =>
      reverseInfluencerPointsForNote(tx, {
        organizationId: b.organizationId,
        invoiceId: invoice.id,
        noteId: note.id,
        noteNumber: String(note.number),
        memberId,
      }),
    );
    expect(again).toBe(0);
  });

  it('takes everything back on a same-day cancellation, once', async () => {
    const start = await balance(contractor);
    const invoice = await sale(contractor, { berger: 2 });
    // Berger ₹800 at every brand: 8.
    expect(await balance(contractor)).toBe(start + 8);
    ok(await owner().post(`/invoices/${invoice.id}/cancel`, { reason: 'Wrong party' }));
    const view = await loyalty(contractor);
    expect(view.balance).toBe(start);
    expect(view.ledger.items[0]).toMatchObject({
      kind: 'adjust',
      points: -8,
      note: `Painter points, cancelled invoice ${String(invoice.number)}`,
    });
    const reference = {
      organizationId: b.organizationId,
      invoiceId: invoice.id,
      invoiceNumber: String(invoice.number),
      memberId: await issuerOf(invoice.id),
    };
    const retried = await withTenant(t.connection.db, b.organizationId, async (tx) => ({
      cancel: await reverseInfluencerPointsForCancel(tx, reference),
      earn: await earnInfluencerPoints(tx, {
        ...reference,
        partyId: b.parties.homeowner,
        influencerPartyId: contractor,
        issuedOn: await dbToday(t),
      }),
    }));
    expect(retried).toEqual({ cancel: 0, earn: null });
  });

  it('never takes the balance below zero: spent points are forgiven', async () => {
    const invoice = await sale(painter, { apex: 5 });
    ok(
      await owner().post(`/parties/${painter}/loyalty/redemptions`, {
        points: await balance(painter),
      }),
    );
    ok(
      await owner().post('/sales-returns', {
        invoiceId: invoice.id,
        lines: [{ invoiceLineId: lineOf(invoice, b.apex), quantity: 5, disposition: 'restock' }],
      }),
    );
    expect(await balance(painter)).toBe(0);
    ok(
      await owner().post(`/invoices/${(await sale(painter, { apex: 1 })).id}/cancel`, {
        reason: 'Wrong item',
      }),
    );
    const cancelled = await sale(painter, { apex: 3 });
    ok(
      await owner().post(`/parties/${painter}/loyalty/redemptions`, {
        points: await balance(painter),
      }),
    );
    ok(await owner().post(`/invoices/${cancelled.id}/cancel`, { reason: 'Spent already' }));
    expect(await balance(painter)).toBe(0);
  });

  it('earns by litre rules, within their dates, and only for those who may earn', async () => {
    const rules = ok(await owner().get('/loyalty-earn-rules')).json<EarnRuleView[]>();
    const litres = String(rules.find((r) => r.name === 'Berger litres')?.id);
    const body = {
      ...rule({ name: 'Berger litres', basis: 'litre', perPaise: null, perMillilitres: 1000 }),
      points: 5,
      brandId: bergerBrand,
    };
    ok(await owner().put(`/loyalty-earn-rules/${litres}`, body));
    // 2 packs of 4 L at 5 points a litre: 40 (the brand's rule wins over every brand).
    let start = await balance(painter);
    await sale(painter, { berger: 2 });
    expect(await balance(painter)).toBe(start + 40);
    // Out of its dates the rule does not apply: every brand's 8.
    ok(
      await owner().put(`/loyalty-earn-rules/${litres}`, {
        ...body,
        validUntil: await dbToday(t, -1),
      }),
    );
    start = await balance(painter);
    await sale(painter, { berger: 2 });
    expect(await balance(painter)).toBe(start + 8);

    // No earning: no influencer, an architect, the buyer tagging themselves, a closed account.
    await sale(null, { berger: 1 });
    await sale(architect, { berger: 1 });
    expect(await balance(architect)).toBe(0);
    const earned = (await loyalty(painter)).painterPoints.earned;
    await sale(painter, { berger: 1 }, painter);
    // The buyer earns as the buyer, not again as their own painter.
    expect((await loyalty(painter)).ledger.items[0]?.kind).toBe('purchase');
    expect((await loyalty(painter)).painterPoints.earned).toBe(earned);
    ok(await owner().patch(`/parties/${contractor}/loyalty`, { status: 'closed' }));
    const before = await balance(contractor);
    await sale(contractor, { berger: 1 });
    expect(await balance(contractor)).toBe(before);
    // Too small to earn: ₹1.18 at 1 point per ₹100.
    const tiny = await b.draft({
      partyId: b.parties.homeowner,
      influencerPartyId: painter,
      lines: [{ variantId: b.apex, quantity: 0.01 }],
    });
    start = await balance(painter);
    ok(await owner().post(`/invoices/${tiny.id}/issue`, {}));
    expect(await balance(painter)).toBe(start);
  });

  it('never posts an invoice’s influencer points twice, and expires them with the programme', async () => {
    ok(
      await owner().put('/loyalty-settings', {
        earnPoints: 1,
        earnPerPaise: 10_000,
        tiers: [],
        expiryDays: 365,
        minRedemptionPoints: 0,
      }),
    );
    const invoice = await sale(painter, { apex: 1 });
    const [entry] = await t.connection.db
      .select()
      .from(loyaltyLedger)
      .where(
        and(eq(loyaltyLedger.taxDocumentId, invoice.id), eq(loyaltyLedger.kind, 'influencer')),
      );
    expect(entry).toMatchObject({ points: 2, expiresOn: await dbToday(t, 365) });
    await expect(
      withTenant(t.connection.db, b.organizationId, (tx) =>
        tx
          .insert(loyaltyLedger)
          .values({ ...entry, id: undefined } as typeof loyaltyLedger.$inferInsert),
      ),
    ).rejects.toThrow();
  });

  it('shows the points in the sales by influencer report', async () => {
    const page = ok(await owner().get('/reports/sales-by-influencer')).json<ReportPage>();
    const ravi = page.rows.filter((row) => row.influencer === 'Ravi Painter');
    // Issued bills and notes only: cancelled invoices are left out, with their points.
    const [expected] = await t.connection.db
      .select({ points: sql<number>`sum(${loyaltyLedger.points})::int` })
      .from(loyaltyLedger)
      .innerJoin(schema.loyaltyAccounts, eq(schema.loyaltyAccounts.id, loyaltyLedger.accountId))
      .innerJoin(schema.taxDocuments, eq(schema.taxDocuments.id, loyaltyLedger.taxDocumentId))
      .where(
        and(
          eq(schema.loyaltyAccounts.partyId, painter),
          eq(schema.taxDocuments.status, 'issued'),
          sql`${loyaltyLedger.kind} in ('influencer', 'adjust')`,
          sql`${schema.taxDocuments.partyId} <> ${painter}`,
        ),
      );
    expect(ravi).toHaveLength(1);
    expect(ravi[0]?.points).toBe(expected?.points);
    expect(expected?.points).toBeGreaterThan(0);
    expect(page.rows.find((row) => row.influencer === 'Asha Architect')?.points).toBe(0);
  });
});
