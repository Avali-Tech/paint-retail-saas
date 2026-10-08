import {
  findPartyBalanceMismatches,
  findStockMismatches,
  migrateDatabase,
  postStockMovements,
  schema,
  withTenant,
} from '@paint/db';
import {
  financialYear,
  gstinCheckCharacter,
  type DocumentSeriesView,
  type GstinProfileView,
  type SalesSettingsView,
  type TaxCategoryOptions,
  type TaxDocumentPage,
  type TaxDocumentView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

const { partyBalances, partyLedger, stockBalances, stockLedger, taxDocumentLinks, taxDocuments } =
  schema;

let database: TestDatabase;
let t: TestApp;

const PAN = 'AABCS1429B';
/** A GSTIN with a correct check character. */
const gstin = (state: string, pan = PAN, entity = '1') => {
  const first14 = `${state}${pan}${entity}Z`;
  return `${first14}${gstinCheckCharacter(first14)}`;
};
const AP_BUYER_GSTIN = gstin('37', 'AAACR5055K');
const TS_BUYER_GSTIN = gstin('36', 'AAACT2727Q');

type Reply = Awaited<ReturnType<TestApp['app']['inject']>>;
const api = (token: string, headers: Record<string, string> = {}) => {
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { ...bearer(token), ...headers }, payload });
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload: object = {}) => call('POST', url, payload),
    put: (url: string, payload: object) => call('PUT', url, payload),
    delete: (url: string) => call('DELETE', url),
  };
};
/** The reply, after checking it succeeded (its body in the error otherwise). */
const ok = (reply: Reply): Reply => {
  if (reply.statusCode >= 400) throw new Error(`${String(reply.statusCode)}: ${reply.body}`);
  return reply;
};
const issuesOf = (reply: Reply) =>
  reply.json<{ issues: { path: string; message: string }[] }>().issues.map((issue) => issue.path);

interface Business {
  readonly owner: string;
  readonly organizationId: string;
  readonly stores: { amp: string; kkp: string; sec: string; unr: string };
  readonly variants: {
    apex1: string;
    apex20: string;
    brush: string;
    putty4: string;
    exempt: string;
    nil: string;
    noPrice: string;
  };
  readonly parties: {
    tsWalkIn: string;
    apCustomer: string;
    apDealer: string;
    tsDealer: string;
    painter: string;
  };
  member(roleKey: string, storeIds: string[]): Promise<string>;
}

/** Today in India from the database clock, never the Node clock. */
async function dbToday(): Promise<string> {
  const result = await t.connection.db.execute<{ today: string }>(
    sql`select ((now() at time zone 'Asia/Kolkata')::date)::text as today`,
  );
  return String(result.rows[0]?.today);
}

let businesses = 0;
async function business(): Promise<Business> {
  businesses += 1;
  const signup = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: `Rangoli Paints ${String(businesses)}`,
      fullName: 'Owner',
      phone: uniquePhone(),
      password: 'Rangoli@2026',
    },
  });
  const { token: owner, organizationId } = signup.json<{ token: string; organizationId: string }>();
  const o = api(owner);
  const store = async (name: string, code: string) =>
    ok(await o.post('/stores', { name, code })).json<{ id: string }>().id;
  const stores = {
    amp: await store('Ameerpet', 'AMP'),
    kkp: await store('Kukatpally', 'KKP'),
    sec: await store('Secunderabad', 'SEC'),
    unr: await store('Godown counter', 'UNR'),
  };
  ok(await o.put('/gst-registrations/business', { legalName: 'Rangoli Paints Private Limited' }));
  const register = async (storeId: string, registrationType: string, entity: string) =>
    ok(
      await o.put(`/gst-registrations/stores/${storeId}`, {
        registrationType,
        stateCode: '36',
        gstin: gstin('36', PAN, entity),
        addressLine: '1-2-3 Main Road',
        city: 'Hyderabad',
        pincode: '500016',
      }),
    );
  await register(stores.amp, 'regular', '1');
  await register(stores.kkp, 'regular', '1');
  await register(stores.sec, 'composition', '2');

  const options = ok(await o.get('/tax-categories/options')).json<TaxCategoryOptions>();
  const category = (key: string) => String(options.categories.find((c) => c.key === key)?.id);
  const nilRated = ok(
    await o.post('/tax-categories', { name: 'Nil rated', rateBps: 0, effectiveFrom: '2017-07-01' }),
  ).json<{ id: string }>().id;
  const brandId = ok(await o.post('/brands', { name: 'Asian Paints' })).json<{ id: string }>().id;
  const product = async (body: object) =>
    ok(await o.post('/products', { brandId, ...body })).json<{
      variants: { id: string; sku: string }[];
    }>().variants;
  const apex = await product({
    name: 'Apex Ultima',
    type: 'exterior_paint',
    hsnCode: '32091090',
    taxCategoryId: category('paints'),
    variants: [
      { sku: 'APX-1L', packSize: 1, unit: 'l', mrpPaise: 12_000, sellingPricePaise: 11_800 },
      {
        sku: 'APX-20L',
        packSize: 20,
        unit: 'l',
        mrpPaise: 1_200_000,
        sellingPricePaise: 1_045_000,
      },
    ],
  });
  const brush = await product({
    name: 'Paint Roller',
    type: 'tool',
    hsnCode: '96034000',
    taxCategoryId: category('brushes_rollers'),
    variants: [
      { sku: 'ROL-9', packSize: 1, unit: 'piece', label: '9 inch', sellingPricePaise: 26_000 },
    ],
  });
  const putty = await product({
    name: 'Wall Putty',
    type: 'putty',
    hsnCode: '3214',
    taxCategoryId: category('putty'),
    variants: [{ sku: 'PTY-4KG', packSize: 4, unit: 'kg', sellingPricePaise: 50_000 }],
  });
  const exempt = await product({
    name: 'Sample card',
    type: 'other',
    hsnCode: '49111010',
    taxCategoryId: category('exempt'),
    variants: [
      { sku: 'CARD-1', packSize: 1, unit: 'piece', sellingPricePaise: 1_000 },
      { sku: 'CARD-2', packSize: 2, unit: 'piece' },
    ],
  });
  const nil = await product({
    name: 'Shade fan deck',
    type: 'other',
    hsnCode: '49111020',
    taxCategoryId: nilRated,
    variants: [{ sku: 'FAN-1', packSize: 1, unit: 'set', sellingPricePaise: 5_000 }],
  });
  const variant = (list: { id: string; sku: string }[], sku: string) =>
    String(list.find((v) => v.sku === sku)?.id);
  const variants = {
    apex1: variant(apex, 'APX-1L'),
    apex20: variant(apex, 'APX-20L'),
    brush: variant(brush, 'ROL-9'),
    putty4: variant(putty, 'PTY-4KG'),
    exempt: variant(exempt, 'CARD-1'),
    nil: variant(nil, 'FAN-1'),
    noPrice: variant(exempt, 'CARD-2'),
  };
  // Opening stock at every store.
  await withTenant(t.connection.db, organizationId, (tx) =>
    postStockMovements(
      tx,
      Object.values(stores).flatMap((storeId) =>
        Object.values(variants).map((variantId) => ({
          organizationId,
          storeId,
          variantId,
          movementType: 'opening' as const,
          quantity: 1_000,
        })),
      ),
    ),
  );

  const party = async (body: object) =>
    ok(await o.post('/parties', { roles: ['customer'], ...body })).json<{ id: string }>().id;
  const parties = {
    tsWalkIn: await party({ displayName: 'Suresh', phone: uniquePhone(), placeOfSupply: '36' }),
    apCustomer: await party({
      displayName: 'Ramana',
      phone: uniquePhone(),
      addressLine: '4-5 Beach Road',
      city: 'Visakhapatnam',
      state: 'Andhra Pradesh',
      pincode: '530002',
      placeOfSupply: '37',
    }),
    apDealer: await party({
      kind: 'organization',
      displayName: 'Vizag Builders',
      legalName: 'Vizag Builders LLP',
      gstin: AP_BUYER_GSTIN,
    }),
    tsDealer: await party({
      kind: 'organization',
      displayName: 'Deccan Interiors',
      gstin: TS_BUYER_GSTIN,
    }),
    painter: await party({ displayName: 'Ravi Painter', phone: uniquePhone(), roles: ['painter'] }),
  };
  const roles = ok(await o.get('/roles')).json<{ id: string; key: string }[]>();
  return {
    owner,
    organizationId,
    stores,
    variants,
    parties,
    async member(roleKey, storeIds) {
      const phone = uniquePhone();
      ok(
        await o.post('/members', {
          fullName: `Staff ${roleKey}`,
          phone,
          password: 'Staff@2026',
          roleId: roles.find((role) => role.key === roleKey)?.id,
          storeIds,
        }),
      );
      const login = await t.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { identifier: phone, password: 'Staff@2026' },
      });
      return login.json<{ token: string }>().token;
    },
  };
}

let b: Business;
let fy: string;

/** A draft at `storeId` (Ameerpet by default) with these lines, as the given member. */
async function draft(body: object, token = b.owner): Promise<TaxDocumentView> {
  return ok(
    await api(token).post('/invoices', { storeId: b.stores.amp, ...body }),
  ).json<TaxDocumentView>();
}
const line = (variantId: string, quantity = 1, extra: object = {}) => ({
  variantId,
  quantity,
  ...extra,
});
const issue = (id: string, body: object = {}, token = b.owner) =>
  api(token).post(`/invoices/${id}/issue`, body);
async function issued(body: object, issueBody: object = {}): Promise<TaxDocumentView> {
  const document = await draft(body);
  return ok(await issue(document.id, issueBody)).json<TaxDocumentView>();
}

async function onHand(storeId: string, variantId: string): Promise<number> {
  const [row] = await t.connection.db
    .select({ onHand: stockBalances.onHand })
    .from(stockBalances)
    .where(and(eq(stockBalances.storeId, storeId), eq(stockBalances.variantId, variantId)));
  return Number(row?.onHand);
}
const ledgerOf = (documentId: string) =>
  t.connection.db
    .select({
      entryType: partyLedger.entryType,
      amountPaise: partyLedger.amountPaise,
      partyId: partyLedger.partyId,
    })
    .from(partyLedger)
    .where(eq(partyLedger.referenceId, documentId))
    .orderBy(partyLedger.createdAt);
async function balanceOf(partyId: string): Promise<number> {
  const [row] = await t.connection.db
    .select({ balancePaise: partyBalances.balancePaise })
    .from(partyBalances)
    .where(eq(partyBalances.partyId, partyId));
  return Number(row?.balancePaise);
}
const serialOf = (number: string | null) => Number(String(number).split('/')[2]);

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await business();
  fy = financialYear(await dbToday());
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('sales settings', () => {
  it('starts with the defaults and saves changes for owners only', async () => {
    const fresh = await business();
    const o = api(fresh.owner);
    expect(ok(await o.get('/sales/settings')).json<SalesSettingsView>()).toEqual({
      stockPostOn: 'invoice',
      walkInPartyId: null,
      quoteValidityDays: 15,
      partialMinAdvancePct: 0,
      defaultPriceMode: 'inclusive',
      billingLiveOn: null,
      cashNeedsRegister: true,
      registerVarianceAlertPaise: 0,
    });
    const saved = ok(
      await o.put('/sales/settings', {
        quoteValidityDays: 30,
        defaultPriceMode: 'exclusive',
        walkInPartyId: fresh.parties.tsWalkIn,
      }),
    ).json<SalesSettingsView>();
    expect(saved).toMatchObject({
      quoteValidityDays: 30,
      defaultPriceMode: 'exclusive',
      billingLiveOn: null,
      walkInPartyId: fresh.parties.tsWalkIn,
    });
    // Billing goes live through POST /sales/go-live, with its opening balances (round 4a).
    expect((await o.put('/sales/settings', { billingLiveOn: '2026-10-01' })).statusCode).toBe(400);
    expect(
      ok(await o.put('/sales/settings', { partialMinAdvancePct: 25 })).json<SalesSettingsView>(),
    ).toMatchObject({
      quoteValidityDays: 30,
      partialMinAdvancePct: 25,
    });

    const unknown = await o.put('/sales/settings', { walkInPartyId: crypto.randomUUID() });
    expect(unknown.statusCode).toBe(400);
    expect(issuesOf(unknown)).toEqual(['walkInPartyId']);
    const manager = await fresh.member('branch_manager', [fresh.stores.amp]);
    expect((await api(manager).get('/sales/settings')).statusCode).toBe(403);

    // A draft without a price mode takes the business's default.
    const document = ok(
      await o.post('/invoices', { storeId: fresh.stores.amp, lines: [line(fresh.variants.apex1)] }),
    ).json<TaxDocumentView>();
    expect(document.priceMode).toBe('exclusive');
  });
});

describe('document series', () => {
  it('numbers within 16 characters and keeps one active series per store and kind', async () => {
    const fresh = await business();
    const o = api(fresh.owner);
    expect(ok(await o.get('/document-series')).json<DocumentSeriesView[]>()).toEqual([]);

    const tooLong = await o.post('/document-series', {
      storeId: fresh.stores.amp,
      kind: 'invoice',
      prefix: 'AMEERPT',
      digits: 6,
    });
    expect(issuesOf(tooLong)).toEqual(['prefix']);
    const first = ok(
      await o.post('/document-series', {
        storeId: fresh.stores.amp,
        kind: 'invoice',
        prefix: 'amp',
        digits: 6,
      }),
    ).json<DocumentSeriesView>();
    expect(first).toMatchObject({
      prefix: 'AMP',
      digits: 6,
      isActive: true,
      sample: `AMP/${fy.slice(2)}/000001`,
    });
    const second = ok(
      await o.post('/document-series', {
        storeId: fresh.stores.amp,
        kind: 'invoice',
        prefix: 'AMPT',
        digits: 5,
      }),
    ).json<DocumentSeriesView>();
    const listed = ok(await o.get(`/document-series?storeId=${fresh.stores.amp}`)).json<
      DocumentSeriesView[]
    >();
    expect(listed.map((series) => [series.prefix, series.isActive])).toEqual([
      ['AMP', false],
      ['AMPT', true],
    ]);

    const clash = await o.put(`/document-series/${first.id}`, { isActive: true });
    expect(clash.statusCode).toBe(409);
    expect(
      ok(
        await o.put(`/document-series/${second.id}`, { isActive: false }),
      ).json<DocumentSeriesView>().isActive,
    ).toBe(false);
    expect(
      ok(await o.put(`/document-series/${first.id}`, { isActive: true })).json<DocumentSeriesView>()
        .isActive,
    ).toBe(true);

    // The issued invoice uses the active series.
    const document = ok(
      await o.post('/invoices', { storeId: fresh.stores.amp, lines: [line(fresh.variants.apex1)] }),
    ).json<TaxDocumentView>();
    expect(ok(await o.post(`/invoices/${document.id}/issue`)).json<TaxDocumentView>().number).toBe(
      `AMP/${fy.slice(2)}/000001`,
    );

    // Stores the member does not work at are out of reach.
    const cashier = await fresh.member('store_employee', [fresh.stores.kkp]);
    expect(ok(await api(cashier).get('/document-series')).json<DocumentSeriesView[]>()).toEqual([]);
    expect(
      (await api(cashier).put(`/document-series/${first.id}`, { isActive: false })).statusCode,
    ).toBe(404);
    expect(
      (
        await api(cashier).post('/document-series', {
          storeId: fresh.stores.amp,
          kind: 'invoice',
          prefix: 'X',
          digits: 6,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await o.post('/document-series', {
          storeId: crypto.randomUUID(),
          kind: 'invoice',
          prefix: 'X',
          digits: 6,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('refuses to make up a series for a store whose code is too long', async () => {
    const o = api(b.owner);
    const longStore = ok(await o.post('/stores', { name: 'Long', code: 'KUKATPALLY1' })).json<{
      id: string;
    }>().id;
    ok(
      await o.put(`/gst-registrations/stores/${longStore}`, {
        registrationType: 'regular',
        stateCode: '36',
        gstin: gstin('36', PAN, '1'),
      }),
    );
    await withTenant(t.connection.db, b.organizationId, (tx) =>
      postStockMovements(tx, [
        {
          organizationId: b.organizationId,
          storeId: longStore,
          variantId: b.variants.apex1,
          movementType: 'opening',
          quantity: 5,
        },
      ]),
    );
    const document = await draft({ storeId: longStore, lines: [line(b.variants.apex1)] });
    const refused = await issue(document.id);
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ message: string }>().message).toMatch(/Set up a document series/);
  });
});

describe('GSTIN profiles', () => {
  it('lists each registered GSTIN with defaults and saves the turnover band and e-invoice date', async () => {
    const fresh = await business();
    const o = api(fresh.owner);
    expect(ok(await o.get('/gstin-profiles')).json<GstinProfileView[]>()).toEqual([
      {
        gstin: gstin('36', PAN, '1'),
        stateCode: '36',
        aatoBand: 'up_to_5cr',
        einvoiceRequiredFrom: null,
        ewayThresholdPaise: 5_000_000,
      },
      {
        gstin: gstin('36', PAN, '2'),
        stateCode: '36',
        aatoBand: 'up_to_5cr',
        einvoiceRequiredFrom: null,
        ewayThresholdPaise: 5_000_000,
      },
    ]);
    const body = {
      aatoBand: 'above_5cr',
      einvoiceRequiredFrom: '2023-08-01',
      ewayThresholdPaise: 10_000_000,
    };
    expect(
      ok(
        await o.put(`/gstin-profiles/${gstin('36', PAN, '1').toLowerCase()}`, body),
      ).json<GstinProfileView>(),
    ).toMatchObject(body);
    expect(ok(await o.get('/gstin-profiles')).json<GstinProfileView[]>()[0]).toMatchObject(body);
    expect((await o.put(`/gstin-profiles/${AP_BUYER_GSTIN}`, body)).statusCode).toBe(404);
    expect((await o.put('/gstin-profiles/NOT-A-GSTIN', body)).statusCode).toBe(400);
    const manager = await fresh.member('branch_manager', [fresh.stores.amp]);
    expect(
      (await api(manager).put(`/gstin-profiles/${gstin('36', PAN, '1')}`, body)).statusCode,
    ).toBe(403);
  });
});

describe('drafts', () => {
  it('saves a held bill with prices from the catalogue, no number, no stock and no ledger', async () => {
    const before = await onHand(b.stores.amp, b.variants.apex1);
    const document = await draft({
      partyId: b.parties.tsWalkIn,
      influencerPartyId: b.parties.painter,
      buyer: { name: 'Suresh K', address: 'Ameerpet', stateCode: '36' },
      shipTo: { stateCode: '36' },
      billDiscount: { kind: 'percent', basisPoints: 500 },
      dueOn: '2026-12-31',
      note: 'Hold for pickup',
      lines: [
        line(b.variants.apex1, 2),
        line(b.variants.brush, 1, {
          unitPricePaise: 25_000,
          discount: { kind: 'amount', paise: 1_000 },
        }),
      ],
    });
    expect(document).toMatchObject({
      kind: 'invoice',
      status: 'draft',
      number: null,
      priceMode: 'inclusive',
      billDiscountBps: 500,
      billDiscountPaise: null,
      buyer: {
        partyId: b.parties.tsWalkIn,
        name: 'Suresh K',
        gstin: null,
        address: 'Ameerpet',
        stateCode: '36',
      },
      shipTo: { name: null, address: null, stateCode: '36' },
      influencerPartyId: b.parties.painter,
      dueOn: '2026-12-31',
      totalPaise: 0,
      issuedAt: null,
    });
    expect(
      document.lines.map((l) => [
        l.lineNo,
        l.quantity,
        l.unitPricePaise,
        l.discountBps,
        l.discountPaise,
      ]),
    ).toEqual([
      [1, 2, 11_800, null, null],
      [2, 1, 25_000, null, 1_000],
    ]);
    expect(await onHand(b.stores.amp, b.variants.apex1)).toBe(before);
    expect(await ledgerOf(document.id)).toEqual([]);

    const updated = ok(
      await api(b.owner).put(`/invoices/${document.id}`, {
        storeId: b.stores.amp,
        priceMode: 'exclusive',
        billDiscount: { kind: 'amount', paise: 100 },
        shipTo: { name: 'Site', address: 'Plot 4', stateCode: '37' },
        lines: [line(b.variants.putty4, 3, { discount: { kind: 'percent', basisPoints: 1000 } })],
      }),
    ).json<TaxDocumentView>();
    expect(updated).toMatchObject({
      priceMode: 'exclusive',
      billDiscountBps: null,
      billDiscountPaise: 100,
      buyer: { partyId: null, name: null },
      shipTo: { name: 'Site', address: 'Plot 4', stateCode: '37' },
    });
    expect(updated.lines.map((l) => [l.variantId, l.discountBps])).toEqual([
      [b.variants.putty4, 1000],
    ]);
    expect(
      ok(await api(b.owner).get(`/invoices/${document.id}`)).json<TaxDocumentView>().lines,
    ).toHaveLength(1);

    expect((await api(b.owner).delete(`/invoices/${document.id}`)).statusCode).toBe(204);
    expect((await api(b.owner).get(`/invoices/${document.id}`)).statusCode).toBe(404);
  });

  it('refuses unknown or out-of-reach stores, parties, sites and products', async () => {
    const o = api(b.owner);
    const post = (body: object) =>
      o.post('/invoices', { storeId: b.stores.amp, lines: [line(b.variants.apex1)], ...body });
    expect(issuesOf(await post({ storeId: crypto.randomUUID() }))).toEqual(['storeId']);
    expect(issuesOf(await post({ partyId: crypto.randomUUID() }))).toEqual(['partyId']);
    expect(issuesOf(await post({ influencerPartyId: b.parties.apCustomer }))).toEqual([
      'influencerPartyId',
    ]);
    expect(issuesOf(await post({ projectId: crypto.randomUUID() }))).toEqual(['projectId']);
    expect(
      issuesOf(await post({ lines: [line(b.variants.apex1), line(crypto.randomUUID())] })),
    ).toEqual(['lines.1.variantId']);
    expect(issuesOf(await post({ lines: [line(b.variants.noPrice)] }))).toEqual([
      'lines.0.unitPricePaise',
    ]);
    expect(issuesOf(await post({ lines: [line(b.variants.apex1, 0.0001)] }))).toEqual([
      'lines.0.quantity',
    ]);
    const cashier = await b.member('store_employee', [b.stores.kkp]);
    expect(
      (
        await api(cashier).post('/invoices', {
          storeId: b.stores.amp,
          lines: [line(b.variants.apex1)],
        })
      ).statusCode,
    ).toBe(403);
    // A site of the business is accepted.
    const project = ok(
      await o.post('/projects', {
        storeId: b.stores.amp,
        name: 'Villa 12',
        customerPartyId: b.parties.apCustomer,
      }),
    ).json<{ id: string }>();
    expect((await post({ projectId: project.id })).statusCode).toBe(201);
  });
});

describe('issuing', () => {
  it('bills a Telangana walk-in at a Telangana store with CGST + SGST, numbered, stock out, ledger in', async () => {
    const before = await onHand(b.stores.amp, b.variants.apex1);
    const invoice = await issued({ lines: [line(b.variants.apex1, 2), line(b.variants.brush)] });
    const today = await dbToday();
    expect(invoice).toMatchObject({
      kind: 'invoice',
      status: 'issued',
      fy,
      issuedOn: today,
      supplier: {
        gstin: gstin('36', PAN, '1'),
        stateCode: '36',
        legalName: 'Rangoli Paints Private Limited',
        tradeName: null,
        address: '1-2-3 Main Road, Hyderabad, Telangana, 500016',
      },
      buyer: { name: null, gstin: null },
      placeOfSupplyCode: '36',
      supplyType: 'intra_state',
      gstClass: 'b2cs',
      igstPaise: 0,
      dueOn: today,
    });
    expect(invoice.number).toMatch(new RegExp(`^AMP/${fy.slice(2)}/\\d{6}$`));
    expect(invoice.number).toHaveLength(16);
    // 2 × ₹118 + ₹260 inclusive of 18%: ₹496 in all.
    expect(invoice.totalPaise).toBe(49_600);
    expect(invoice.cgstPaise).toBe(invoice.sgstPaise);
    expect(
      invoice.taxablePaise + invoice.cgstPaise + invoice.sgstPaise + invoice.roundOffPaise,
    ).toBe(49_600);
    expect(invoice.lines.map((l) => [l.description, l.hsnCode, l.uqc, l.rateBps])).toEqual([
      ['Apex Ultima 1 l', '32091090', 'LTR', 1800],
      ['Paint Roller 9 inch', '96034000', 'PCS', 1800],
    ]);
    expect(invoice.taxRows.map((row) => [row.hsnCode, row.rateBps])).toEqual([
      ['32091090', 1800],
      ['96034000', 1800],
    ]);
    expect(await onHand(b.stores.amp, b.variants.apex1)).toBe(before - 2);
    const settings = ok(await api(b.owner).get('/sales/settings')).json<SalesSettingsView>();
    expect(invoice.buyer.partyId).toBe(settings.walkInPartyId);
    expect(await ledgerOf(invoice.id)).toEqual([
      { entryType: 'invoice', amountPaise: 49_600, partyId: settings.walkInPartyId },
    ]);

    // The next walk-in bill uses the same walk-in party and the next number.
    const next = await issued({ lines: [line(b.variants.brush)] });
    expect(next.buyer.partyId).toBe(settings.walkInPartyId);
    expect(serialOf(next.number)).toBe(serialOf(invoice.number) + 1);
  });

  it('charges IGST to Andhra Pradesh buyers, registered or not, and to goods delivered there', async () => {
    const unregistered = await issued({
      partyId: b.parties.apCustomer,
      lines: [line(b.variants.apex1)],
    });
    expect(unregistered).toMatchObject({
      supplyType: 'inter_state',
      placeOfSupplyCode: '37',
      gstClass: 'b2cs',
      cgstPaise: 0,
      sgstPaise: 0,
      buyer: {
        name: 'Ramana',
        gstin: null,
        address: '4-5 Beach Road, Visakhapatnam, Andhra Pradesh, 530002',
        stateCode: '37',
      },
    });
    expect(unregistered.igstPaise).toBeGreaterThan(0);

    const registered = await issued({
      partyId: b.parties.apDealer,
      lines: [line(b.variants.apex20)],
    });
    expect(registered).toMatchObject({
      supplyType: 'inter_state',
      placeOfSupplyCode: '37',
      gstClass: 'b2b',
      buyer: { name: 'Vizag Builders LLP', gstin: AP_BUYER_GSTIN },
    });

    const delivered = await issued({
      partyId: b.parties.tsWalkIn,
      shipTo: { stateCode: '37' },
      lines: [line(b.variants.apex1)],
    });
    expect(delivered).toMatchObject({
      supplyType: 'inter_state',
      placeOfSupplyCode: '37',
      buyer: { stateCode: '36' },
    });

    // A Telangana dealer stays intra-state.
    const local = await issued({ partyId: b.parties.tsDealer, lines: [line(b.variants.apex1)] });
    expect(local).toMatchObject({ supplyType: 'intra_state', gstClass: 'b2b', igstPaise: 0 });
  });

  it('classes inter-state B2C above ₹1 lakh as B2C large, and wants the buyer from ₹50,000', async () => {
    const bigLines = [line(b.variants.apex20, 12)];
    const walkIn = await draft({ lines: bigLines });
    const refused = await issue(walkIn.id);
    expect(refused.statusCode).toBe(422);
    expect(issuesOf(refused)).toEqual(['buyer.name', 'buyer.address', 'buyer.stateCode']);
    expect(
      ok(await api(b.owner).get(`/invoices/${walkIn.id}`)).json<TaxDocumentView>().status,
    ).toBe('draft');

    const large = await issued({ partyId: b.parties.apCustomer, lines: bigLines });
    expect(large).toMatchObject({ gstClass: 'b2cl', supplyType: 'inter_state' });
    const typed = await issued({
      buyer: { name: 'Mohan', address: 'Kondapur', stateCode: '36' },
      lines: bigLines,
    });
    expect(typed).toMatchObject({ gstClass: 'b2cs', buyer: { name: 'Mohan' } });
  });

  it('applies discounts, exclusive prices, and exempt and nil-rated goods', async () => {
    const invoice = await issued({
      priceMode: 'exclusive',
      billDiscount: { kind: 'amount', paise: 1_000 },
      lines: [
        line(b.variants.putty4, 2, {
          unitPricePaise: 10_000,
          discount: { kind: 'percent', basisPoints: 1000 },
        }),
        line(b.variants.exempt),
        line(b.variants.nil),
      ],
    });
    expect(invoice.lines.map((l) => [l.rateBps, l.cgstPaise])).toEqual([
      [1800, expect.any(Number)],
      [0, 0],
      [0, 0],
    ]);
    // ₹200 less 10% = ₹180, plus ₹10 and ₹50, less ₹10 off the bill: ₹230 taxable before tax.
    expect(invoice.taxablePaise).toBe(23_000);
    expect(invoice.totalPaise % 100).toBe(0);
  });

  it('issues a bill of supply without tax from a composition store, and never inter-state', async () => {
    const bill = await issued({ storeId: b.stores.sec, lines: [line(b.variants.apex1, 3)] });
    expect(bill).toMatchObject({
      kind: 'bill_of_supply',
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
      taxablePaise: 35_400,
      totalPaise: 35_400,
    });
    expect(bill.number).toMatch(new RegExp(`^SECB/${fy.slice(2)}/\\d{5}$`));
    expect(bill.lines[0]?.rateBps).toBeNull();
    expect(bill.taxRows).toEqual([]);

    const interState = await draft({
      storeId: b.stores.sec,
      partyId: b.parties.apCustomer,
      lines: [line(b.variants.apex1)],
    });
    const refused = await issue(interState.id);
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ code: string }>().code).toBe('composition_inter_state');
  });

  it('refuses an unregistered store, a product without a tax category or enough HSN digits', async () => {
    const atUnregistered = await draft({ storeId: b.stores.unr, lines: [line(b.variants.apex1)] });
    expect((await issue(atUnregistered.id)).statusCode).toBe(409);

    const document = await draft({ lines: [line(b.variants.brush), line(b.variants.exempt)] });
    await t.connection.db.execute(
      sql`update products set tax_category_id = null where id = (select product_id from product_variants where id = ${b.variants.exempt})`,
    );
    const uncategorised = await issue(document.id);
    await t.connection.db.execute(
      sql`update products set tax_category_id = (select id from tax_categories where key = 'exempt' and organization_id = ${b.organizationId}) where id = (select product_id from product_variants where id = ${b.variants.exempt})`,
    );
    expect(uncategorised.statusCode).toBe(422);
    expect(issuesOf(uncategorised)).toEqual(['lines.1.variantId']);

    // Above ₹5 crore every invoice needs 6 HSN digits; putty has 4.
    const fresh = await business();
    ok(
      await api(fresh.owner).put(`/gstin-profiles/${gstin('36', PAN, '1')}`, {
        aatoBand: 'above_5cr',
        einvoiceRequiredFrom: null,
        ewayThresholdPaise: 5_000_000,
      }),
    );
    const putty = ok(
      await api(fresh.owner).post('/invoices', {
        storeId: fresh.stores.amp,
        lines: [line(fresh.variants.apex1), line(fresh.variants.putty4)],
      }),
    ).json<TaxDocumentView>();
    const short = await api(fresh.owner).post(`/invoices/${putty.id}/issue`);
    expect(short.statusCode).toBe(422);
    expect(issuesOf(short)).toEqual(['lines.1.variantId']);
  });

  it('refuses a B2B invoice without an IRN once the GSTIN must e-invoice', async () => {
    const fresh = await business();
    const o = api(fresh.owner);
    ok(
      await o.put(`/gstin-profiles/${gstin('36', PAN, '1')}`, {
        aatoBand: 'up_to_5cr',
        einvoiceRequiredFrom: '2023-08-01',
        ewayThresholdPaise: 5_000_000,
      }),
    );
    const b2b = ok(
      await o.post('/invoices', {
        storeId: fresh.stores.amp,
        partyId: fresh.parties.apDealer,
        lines: [line(fresh.variants.apex1)],
      }),
    ).json<TaxDocumentView>();
    const refused = await o.post(`/invoices/${b2b.id}/issue`);
    expect(refused.statusCode).toBe(422);
    expect(issuesOf(refused)).toEqual(['einvoice']);
    const irn = 'a'.repeat(64);
    const withIrn = ok(
      await o.post(`/invoices/${b2b.id}/issue`, {
        einvoice: { irn, ackNo: '112410000123456', ackAt: '2026-10-07T10:00:00+05:30' },
      }),
    ).json<TaxDocumentView>();
    expect(withIrn).toMatchObject({ status: 'issued', irn, ackNo: '112410000123456' });
    // B2C sales are not e-invoiced.
    const b2c = ok(
      await o.post('/invoices', { storeId: fresh.stores.amp, lines: [line(fresh.variants.apex1)] }),
    ).json<TaxDocumentView>();
    expect((await o.post(`/invoices/${b2c.id}/issue`)).statusCode).toBe(200);
  });

  it('rolls back everything when stock runs short: no number is used', async () => {
    const short = await draft({
      storeId: b.stores.kkp,
      lines: [line(b.variants.brush), line(b.variants.exempt, 600), line(b.variants.exempt, 600)],
    });
    const before = await onHand(b.stores.kkp, b.variants.brush);
    const refused = await issue(short.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ message: string }>().message).toBe(
      'Not enough stock of CARD-1 at this store',
    );
    expect(await onHand(b.stores.kkp, b.variants.brush)).toBe(before);
    expect(
      ok(await api(b.owner).get(`/invoices/${short.id}`)).json<TaxDocumentView>(),
    ).toMatchObject({
      status: 'draft',
      number: null,
    });

    // A product the store has never stocked.
    const options = ok(
      await api(b.owner).get('/tax-categories/options'),
    ).json<TaxCategoryOptions>();
    const brands = ok(await api(b.owner).get('/brands')).json<{ id: string }[]>();
    const fresh = ok(
      await api(b.owner).post('/products', {
        brandId: brands[0]?.id,
        name: 'Masking Tape',
        type: 'tool',
        hsnCode: '39191000',
        taxCategoryId: options.categories.find((category) => category.key === 'tools')?.id,
        variants: [{ sku: 'TAPE-1', packSize: 1, unit: 'piece', sellingPricePaise: 4_000 }],
      }),
    ).json<{ variants: { id: string }[] }>().variants;
    const unstocked = await draft({ lines: [line(String(fresh[0]?.id))] });
    const none = await issue(unstocked.id);
    expect(none.statusCode).toBe(409);
    expect(none.json<{ message: string }>().message).toBe(
      'Not enough stock of TAPE-1 at this store',
    );
  });

  it('issues a zero-value bill without a ledger entry, and never changes an issued one', async () => {
    const free = await issued({
      lines: [line(b.variants.brush, 1, { discount: { kind: 'percent', basisPoints: 10_000 } })],
    });
    expect(free.totalPaise).toBe(0);
    expect(await ledgerOf(free.id)).toEqual([]);

    const o = api(b.owner);
    expect((await issue(free.id)).statusCode).toBe(409);
    expect(
      (
        await o.put(`/invoices/${free.id}`, {
          storeId: b.stores.amp,
          lines: [line(b.variants.brush)],
        })
      ).statusCode,
    ).toBe(409);
    expect((await o.delete(`/invoices/${free.id}`)).statusCode).toBe(409);
    const cancelled = ok(
      await o.post(`/invoices/${free.id}/cancel`, { reason: 'Wrong item' }),
    ).json<TaxDocumentView>();
    expect(cancelled.status).toBe('cancelled');
    expect(await ledgerOf(free.id)).toEqual([]);
  });

  it('numbers 20 concurrent issues at one store 1 to 20, without gaps or repeats', async () => {
    const fresh = await business();
    const o = api(fresh.owner);
    const drafts = await Promise.all(
      Array.from({ length: 20 }, async (_, index) =>
        ok(
          await o.post('/invoices', {
            storeId: fresh.stores.kkp,
            partyId: index % 2 === 0 ? fresh.parties.tsDealer : undefined,
            lines: [line(fresh.variants.apex1), line(fresh.variants.brush)],
          }),
        ).json<TaxDocumentView>(),
      ),
    );
    const replies = await Promise.all(
      drafts.map((document) => o.post(`/invoices/${document.id}/issue`)),
    );
    expect(replies.map((reply) => reply.statusCode)).toEqual(Array(20).fill(200));
    const numbers = replies.map((reply) => String(reply.json<TaxDocumentView>().number)).sort();
    expect(numbers).toEqual(
      Array.from(
        { length: 20 },
        (_, index) => `KKP/${fy.slice(2)}/${String(index + 1).padStart(6, '0')}`,
      ),
    );
    expect(await onHand(fresh.stores.kkp, fresh.variants.apex1)).toBe(980);
    // Exactly one walk-in party and one series came out of the race.
    const settings = ok(await o.get('/sales/settings')).json<SalesSettingsView>();
    const walkIns = replies.filter(
      (reply) => reply.json<TaxDocumentView>().buyer.partyId === settings.walkInPartyId,
    );
    expect(walkIns).toHaveLength(10);
    expect(
      ok(await o.get(`/document-series?storeId=${fresh.stores.kkp}`)).json<DocumentSeriesView[]>(),
    ).toHaveLength(1);
  });
});

describe('cancelling', () => {
  it('cancels the same day: stock comes back, the ledger reverses, the number stays', async () => {
    const invoice = await issued({
      partyId: b.parties.tsWalkIn,
      lines: [line(b.variants.apex1, 4)],
    });
    const before = await onHand(b.stores.amp, b.variants.apex1);
    const balanceBefore = await balanceOf(b.parties.tsWalkIn);
    const cashier = await b.member('store_employee', [b.stores.amp]);
    expect(
      (
        await api(cashier).post(`/invoices/${invoice.id}/cancel`, {
          reason: 'Typed the wrong customer',
        })
      ).statusCode,
    ).toBe(403);

    const cancelled = ok(
      await api(b.owner).post(`/invoices/${invoice.id}/cancel`, {
        reason: 'Typed the wrong customer',
      }),
    ).json<TaxDocumentView>();
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      number: invoice.number,
      cancelReason: 'Typed the wrong customer',
    });
    expect(cancelled.cancelledAt).toEqual(expect.any(String));
    expect(await onHand(b.stores.amp, b.variants.apex1)).toBe(before + 4);
    expect(await ledgerOf(invoice.id)).toEqual([
      { entryType: 'invoice', amountPaise: invoice.totalPaise, partyId: b.parties.tsWalkIn },
      { entryType: 'cancellation', amountPaise: -invoice.totalPaise, partyId: b.parties.tsWalkIn },
    ]);
    expect(await balanceOf(b.parties.tsWalkIn)).toBe(balanceBefore - invoice.totalPaise);
    expect(
      (await api(b.owner).post(`/invoices/${invoice.id}/cancel`, { reason: 'Again' })).statusCode,
    ).toBe(409);
    const movements = await t.connection.db
      .select({ type: stockLedger.movementType, quantity: stockLedger.quantity })
      .from(stockLedger)
      .where(eq(stockLedger.referenceId, invoice.id))
      .orderBy(stockLedger.createdAt);
    expect(movements).toEqual([
      { type: 'sale', quantity: -4 },
      { type: 'sale_return', quantity: 4 },
    ]);
  });

  it('refuses drafts, other days and invoices a note refers to', async () => {
    const pending = await draft({ lines: [line(b.variants.brush)] });
    expect(
      (await api(b.owner).post(`/invoices/${pending.id}/cancel`, { reason: 'Nothing' })).statusCode,
    ).toBe(409);

    const yesterday = await issued({ lines: [line(b.variants.brush)] });
    // Only the test can back-date an issued invoice: the trigger is off for one statement.
    await t.connection.db.transaction(async (tx) => {
      await tx.execute(sql`alter table tax_documents disable trigger tax_documents_immutable`);
      await tx.execute(
        sql`update tax_documents set issued_on = issued_on - 1 where id = ${yesterday.id}`,
      );
      await tx.execute(sql`alter table tax_documents enable trigger tax_documents_immutable`);
    });
    const late = await api(b.owner).post(`/invoices/${yesterday.id}/cancel`, {
      reason: 'Too late',
    });
    expect(late.statusCode).toBe(409);
    expect(late.json<{ message: string }>().message).toMatch(/credit note/);

    const noted = await issued({ lines: [line(b.variants.brush)] });
    const note = await draft({ lines: [line(b.variants.brush)] });
    await t.connection.db.insert(taxDocumentLinks).values({
      organizationId: b.organizationId,
      fromDocumentId: note.id,
      toDocumentId: noted.id,
      kind: 'note_of',
    });
    expect(
      (await api(b.owner).post(`/invoices/${noted.id}/cancel`, { reason: 'Has a note' }))
        .statusCode,
    ).toBe(409);
  });
});

describe('idempotency', () => {
  it('returns the first response to a repeated create or issue, and does the work once', async () => {
    const key = crypto.randomUUID();
    const body = { storeId: b.stores.amp, lines: [line(b.variants.apex1)] };
    const first = ok(
      await api(b.owner, { 'idempotency-key': key }).post('/invoices', body),
    ).json<TaxDocumentView>();
    const again = ok(
      await api(b.owner, { 'idempotency-key': key }).post('/invoices', body),
    ).json<TaxDocumentView>();
    expect(again.id).toBe(first.id);
    const other = await api(b.owner, { 'idempotency-key': key }).post('/invoices', {
      ...body,
      note: 'Different',
    });
    expect(other.statusCode).toBe(422);

    const before = await onHand(b.stores.amp, b.variants.apex1);
    const issueKey = { 'idempotency-key': crypto.randomUUID() };
    const [one, two] = await Promise.all([
      api(b.owner, issueKey).post(`/invoices/${first.id}/issue`, {}),
      api(b.owner, issueKey).post(`/invoices/${first.id}/issue`, {}),
    ]);
    expect([one.statusCode, two.statusCode]).toEqual([200, 200]);
    expect(one.json<TaxDocumentView>().number).toBe(two.json<TaxDocumentView>().number);
    expect(await onHand(b.stores.amp, b.variants.apex1)).toBe(before - 1);
    expect(await ledgerOf(first.id)).toHaveLength(1);

    // A day later the key is forgotten, so the same create makes a new draft.
    await t.connection.db.execute(
      sql`update idempotency_keys set created_at = created_at - interval '25 hours' where key = ${key}`,
    );
    const later = ok(
      await api(b.owner, { 'idempotency-key': key }).post('/invoices', body),
    ).json<TaxDocumentView>();
    expect(later.id).not.toBe(first.id);

    expect(
      (await api(b.owner, { 'idempotency-key': 'x'.repeat(201) }).post('/invoices', body))
        .statusCode,
    ).toBe(400);
  });
});

describe('reading and isolation', () => {
  it('lists invoices by store, party, status, date and number, within the member’s stores', async () => {
    const mine = await issued({
      storeId: b.stores.kkp,
      partyId: b.parties.tsDealer,
      lines: [line(b.variants.brush)],
    });
    const o = api(b.owner);
    const list = async (query: string) =>
      ok(await o.get(`/invoices?${query}`)).json<TaxDocumentPage>();
    const today = await dbToday();
    const found = await list(
      `storeId=${b.stores.kkp}&partyId=${b.parties.tsDealer}&status=issued&from=${today}&to=${today}&q=${encodeURIComponent(String(mine.number))}`,
    );
    expect(found.items.map((item) => item.id)).toEqual([mine.id]);
    expect(found.total).toBe(1);
    expect((await list('q=Deccan')).items.some((item) => item.id === mine.id)).toBe(true);
    expect((await list('limit=1')).items).toHaveLength(1);

    const cashier = await b.member('store_employee', [b.stores.amp]);
    const theirs = ok(await api(cashier).get('/invoices?limit=200')).json<TaxDocumentPage>();
    expect(theirs.items.every((item) => item.storeId === b.stores.amp)).toBe(true);
    expect((await api(cashier).get(`/invoices/${mine.id}`)).statusCode).toBe(404);
    expect((await api(cashier).post(`/invoices/${mine.id}/issue`)).statusCode).toBe(404);
  });

  it("never shows or touches another business's invoices", async () => {
    const mine = await issued({ lines: [line(b.variants.brush)] });
    const other = await business();
    const o = api(other.owner);
    expect((await o.get(`/invoices/${mine.id}`)).statusCode).toBe(404);
    expect((await o.post(`/invoices/${mine.id}/cancel`, { reason: 'Not mine' })).statusCode).toBe(
      404,
    );
    expect(
      (
        await o.put(`/invoices/${mine.id}`, {
          storeId: other.stores.amp,
          lines: [line(other.variants.apex1)],
        })
      ).statusCode,
    ).toBe(404);
    expect(ok(await o.get('/invoices')).json<TaxDocumentPage>().total).toBe(0);
    // Nor can a draft use the first business's products or customers.
    expect(
      issuesOf(
        await o.post('/invoices', { storeId: other.stores.amp, lines: [line(b.variants.apex1)] }),
      ),
    ).toEqual(['lines.0.variantId']);
    expect(
      issuesOf(
        await o.post('/invoices', {
          storeId: other.stores.amp,
          partyId: b.parties.tsDealer,
          lines: [line(other.variants.apex1)],
        }),
      ),
    ).toEqual(['partyId']);
  });

  it('refuses to merge away a party with invoices, and moves its draft bills', async () => {
    const o = api(b.owner);
    const party = async (displayName: string) =>
      ok(
        await o.post('/parties', {
          displayName,
          phone: uniquePhone(),
          roles: ['customer', 'painter'],
        }),
      ).json<{ id: string }>().id;
    const billed = await party('Billed Twin');
    const drafted = await party('Draft Twin');
    const survivor = await party('Survivor');
    await issued({ partyId: billed, lines: [line(b.variants.brush)] });
    const held = await draft({
      partyId: drafted,
      influencerPartyId: drafted,
      lines: [line(b.variants.brush)],
    });

    const refused = await o.post(`/parties/${billed}/merge`, { intoPartyId: survivor });
    expect(refused.statusCode).toBe(409);
    const settings = ok(await o.get('/sales/settings')).json<SalesSettingsView>();
    expect(
      (await o.post(`/parties/${String(settings.walkInPartyId)}/merge`, { intoPartyId: survivor }))
        .statusCode,
    ).toBe(409);

    const merged = ok(await o.post(`/parties/${drafted}/merge`, { intoPartyId: survivor })).json<{
      moved: Record<string, number>;
    }>();
    expect(merged.moved).toMatchObject({
      'tax_documents.party_id': 1,
      'tax_documents.influencer_party_id': 1,
    });
    expect(ok(await o.get(`/invoices/${held.id}`)).json<TaxDocumentView>()).toMatchObject({
      buyer: { partyId: survivor },
      influencerPartyId: survivor,
    });
  });

  it('records settings, series, profiles and every issue and cancel in the audit log', async () => {
    const fresh = await business();
    const o = api(fresh.owner);
    ok(await o.put('/sales/settings', { quoteValidityDays: 20 }));
    ok(
      await o.post('/document-series', {
        storeId: fresh.stores.amp,
        kind: 'invoice',
        prefix: 'AMP',
        digits: 6,
      }),
    );
    ok(
      await o.put(`/gstin-profiles/${gstin('36', PAN, '1')}`, {
        aatoBand: 'above_5cr',
        einvoiceRequiredFrom: null,
        ewayThresholdPaise: 5_000_000,
      }),
    );
    const document = ok(
      await o.post('/invoices', { storeId: fresh.stores.amp, lines: [line(fresh.variants.apex1)] }),
    ).json<TaxDocumentView>();
    const invoice = ok(await o.post(`/invoices/${document.id}/issue`)).json<TaxDocumentView>();
    ok(await o.post(`/invoices/${invoice.id}/cancel`, { reason: 'Duplicate bill' }));

    const entries = async (table: string) =>
      ok(await o.get(`/audit-log?table=${table}`)).json<{
        items: { area: string; recordLabel: string; changes: { field: string; label: string }[] }[];
      }>().items;
    const [cancelled, issuedEntry] = await entries('tax_documents');
    expect(issuedEntry).toMatchObject({ area: 'Invoices', recordLabel: invoice.number });
    expect(issuedEntry?.changes.map((change) => change.field)).toEqual(['status', 'number']);
    expect(cancelled?.changes.map((change) => change.label)).toEqual([
      'Status',
      'Cancellation reason',
    ]);
    expect((await entries('sales_settings'))[0]).toMatchObject({
      area: 'Sales settings',
      recordLabel: 'Sales settings',
    });
    expect((await entries('document_series'))[0]).toMatchObject({
      area: 'Document series',
      recordLabel: 'AMP · AMP',
    });
    expect((await entries('gstin_profiles'))[0]).toMatchObject({
      area: 'GSTIN profiles',
      recordLabel: gstin('36', PAN, '1'),
    });
  });

  it('keeps every balance equal to its ledger, and stock equal to its movements', async () => {
    expect(await findPartyBalanceMismatches(t.connection.db)).toEqual([]);
    expect(await findStockMismatches(t.connection.db)).toEqual([]);
    const issuedCount = await t.connection.db.$count(
      taxDocuments,
      eq(taxDocuments.status, 'issued'),
    );
    expect(issuedCount).toBeGreaterThan(20);
  });
});
