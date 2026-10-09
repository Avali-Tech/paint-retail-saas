import { migrateDatabase, postStockMovements, withTenant } from '@paint/db';
import { gstinCheckCharacter } from '@paint/shared';
import type {
  QuotationPage,
  QuotationView,
  SalesOrderView,
  TaxCategoryOptions,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { sql } from 'drizzle-orm';
import { extractText, getDocumentProxy } from 'unpdf';
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

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let today: string;
/** A painter (an influencer) and a site in Andhra Pradesh for the homeowner. */
let painter: string;
let site: string;
/** A variant with no selling price, and one whose product has no tax category. */
let unpriced: string;
let uncategorised: string;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  today = await dbToday(t);
  const o = api(t, b.owner);
  painter = ok(
    await o.post('/parties', {
      displayName: 'Ravi Painter',
      phone: '+919812300001',
      roles: ['painter'],
    }),
  ).json<{ id: string }>().id;
  site = ok(
    await o.post('/projects', {
      storeId: b.stores.amp,
      customerPartyId: b.parties.homeowner,
      name: 'Suresh villa',
      addressLine: 'Plot 4, Beach Road',
      city: 'Vijayawada',
      state: 'Andhra Pradesh',
      pincode: '520001',
    }),
  ).json<{ id: string }>().id;
  const options = ok(await o.get('/tax-categories/options')).json<TaxCategoryOptions>();
  const brandId = ok(await o.post('/brands', { name: 'Berger' })).json<{ id: string }>().id;
  const product = async (name: string, variant: object) =>
    String(
      ok(
        await o.post('/products', {
          brandId,
          name,
          type: 'tool',
          hsnCode: '96034000',
          taxCategoryId: String(options.categories.find((c) => c.key === 'paints')?.id),
          variants: [{ packSize: 1, unit: 'piece', ...variant }],
        }),
      ).json<{ variants: { id: string }[] }>().variants[0]?.id,
    );
  unpriced = await product('Brush', { sku: 'BR-1' });
  uncategorised = await product('Tray', { sku: 'TR-1', sellingPricePaise: 5_000 });
  await t.connection.db.execute(
    sql`update products set tax_category_id = null where id = (select product_id from product_variants where id = ${uncategorised})`,
  );
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

const owner = () => api(t, b.owner);
const quote = (body: object = {}) => ({
  storeId: b.stores.amp,
  billToPartyId: b.parties.homeowner,
  lines: [{ variantId: b.apex, quantity: 2 }],
  ...body,
});
const create = async (body: object = {}, token = b.owner) =>
  ok(await api(t, token).post('/quotations', quote(body))).json<QuotationView>();
const plusDays = (days: number) => dbToday(t, days);

describe('POST /quotations', () => {
  it('prices a quote with the GST engine, numbered and valid for the business default', async () => {
    const headers = { 'idempotency-key': 'quote-1' };
    const first = ok(await api(t, b.owner, headers).post('/quotations', quote()));
    const created = first.json<QuotationView>();

    expect(created).toMatchObject({
      number: expect.stringMatching(/^QT-\d{6}$/),
      version: 1,
      rootQuotationId: created.id,
      status: 'draft',
      storeId: b.stores.amp,
      billTo: { id: b.parties.homeowner, name: 'Suresh', gstin: null },
      influencer: null,
      project: null,
      shipTo: { name: null, address: null, stateCode: null },
      priceMode: 'inclusive',
      placeOfSupplyCode: '36',
      supplyType: 'intra_state',
      taxablePaise: 20_000,
      cgstPaise: 1_800,
      sgstPaise: 1_800,
      igstPaise: 0,
      roundOffPaise: 0,
      totalPaise: 23_600,
      validUntil: await plusDays(15),
      pricedOn: today,
      sentAt: null,
      salesOrderId: null,
      versions: [{ id: created.id, version: 1, status: 'draft', totalPaise: 23_600 }],
    });
    expect(created.lines).toEqual([
      expect.objectContaining({
        lineNo: 1,
        variantId: b.apex,
        sku: 'APX-1L',
        description: 'Apex Ultima 1 l',
        hsnCode: '32091090',
        quantity: 2,
        unitPricePaise: 11_800,
        rateBps: 1800,
        taxablePaise: 20_000,
        totalPaise: 23_600,
      }),
    ]);

    // A retry with the same key is the same quote.
    const again = ok(await api(t, b.owner, headers).post('/quotations', quote()));
    expect(again.json<QuotationView>().id).toBe(created.id);
  });

  it('records the influencer and the site, whose address fills the ship-to and the tax', async () => {
    const created = await create({
      influencerPartyId: painter,
      projectId: site,
      validUntil: await plusDays(3),
      note: 'Two coats',
      billDiscount: { kind: 'percent', basisPoints: 1_000 },
      lines: [
        {
          variantId: b.apex,
          quantity: 1,
          unitPricePaise: 20_000,
          discount: { kind: 'amount', paise: 600 },
        },
      ],
    });

    expect(created).toMatchObject({
      influencer: { id: painter, name: 'Ravi Painter' },
      project: { id: site, name: 'Suresh villa' },
      shipTo: {
        name: 'Suresh villa',
        address: 'Plot 4, Beach Road, Vijayawada, Andhra Pradesh, 520001',
        stateCode: '37',
      },
      placeOfSupplyCode: '37',
      supplyType: 'inter_state',
      billDiscountBps: 1_000,
      cgstPaise: 0,
      validUntil: await plusDays(3),
      note: 'Two coats',
    });
    expect(created.igstPaise).toBeGreaterThan(0);
    expect(created.lines[0]).toMatchObject({ unitPricePaise: 20_000, discountPaise: 600 });

    // A ship-to given wins over the site's address; a site in a state not on the GST list adds none.
    const given = await create({
      projectId: site,
      shipTo: { name: 'Godown', stateCode: '36' },
    });
    expect(given.shipTo).toEqual({ name: 'Godown', address: null, stateCode: '36' });
    const nowhere = ok(
      await owner().post('/projects', {
        storeId: b.stores.amp,
        customerPartyId: b.parties.homeowner,
        name: 'Farm house',
        state: 'Atlantis',
      }),
    ).json<{ id: string }>().id;
    expect((await create({ projectId: nowhere })).shipTo).toEqual({
      name: 'Farm house',
      address: 'Atlantis',
      stateCode: null,
    });
  });

  it('refuses what cannot be quoted', async () => {
    const refused = async (body: object, status: number) => {
      const reply = await owner().post('/quotations', quote(body));
      expect(reply.statusCode).toBe(status);
      return reply;
    };
    expect(issuesOf(await refused({ influencerPartyId: b.parties.homeowner }, 400))).toEqual([
      'influencerPartyId',
    ]);
    expect(issuesOf(await refused({ billToPartyId: crypto.randomUUID() }, 400))).toEqual([
      'billToPartyId',
    ]);
    expect(issuesOf(await refused({ projectId: crypto.randomUUID() }, 400))).toEqual(['projectId']);
    expect(issuesOf(await refused({ storeId: crypto.randomUUID() }, 400))).toEqual(['storeId']);
    expect(issuesOf(await refused({ validUntil: await plusDays(-1) }, 400))).toEqual([
      'validUntil',
    ]);
    await refused({ storeId: b.stores.unr }, 409);
    expect(
      issuesOf(await refused({ lines: [{ variantId: crypto.randomUUID(), quantity: 1 }] }, 400)),
    ).toEqual(['lines.0.variantId']);
    expect(issuesOf(await refused({ lines: [{ variantId: unpriced, quantity: 1 }] }, 400))).toEqual(
      ['lines.0.unitPricePaise'],
    );
    expect(
      issuesOf(await refused({ lines: [{ variantId: uncategorised, quantity: 1 }] }, 400)),
    ).toEqual(['lines.0.variantId']);
    const engine = await refused(
      {
        lines: [{ variantId: b.apex, quantity: 1, discount: { kind: 'amount', paise: 99_999 } }],
      },
      422,
    );
    expect(engine.json<{ code: string }>().code).toBe('discount_exceeds_value');
    expect(
      issuesOf(await refused({ lines: [{ variantId: b.apex, quantity: 0.0001 }] }, 400)),
    ).toEqual(['lines.0.quantity']);

    // Only at a store the member works at, and only with sales:manage.
    const kukatpally = await b.member('sales_executive', [b.stores.kkp]);
    expect((await api(t, kukatpally).post('/quotations', quote())).statusCode).toBe(403);
    const employee = await b.member('store_employee', [b.stores.amp]);
    expect((await api(t, employee).post('/quotations', quote())).statusCode).toBe(403);
  });
});

describe('a composition store', () => {
  it('quotes without tax, as its bill of supply will', async () => {
    const storeId = ok(await owner().post('/stores', { name: 'Secunderabad', code: 'SEC' })).json<{
      id: string;
    }>().id;
    const first14 = '36AABCS1429B2Z';
    ok(
      await owner().put(`/gst-registrations/stores/${storeId}`, {
        registrationType: 'composition',
        stateCode: '36',
        gstin: `${first14}${gstinCheckCharacter(first14)}`,
        addressLine: '9 Market Road',
        city: 'Hyderabad',
        pincode: '500003',
      }),
    );
    const quoted = await create({ storeId });
    expect(quoted).toMatchObject({ taxablePaise: 23_600, cgstPaise: 0, totalPaise: 23_600 });
    expect(quoted.lines[0]?.rateBps).toBeNull();

    // Its order is billed on a bill of supply.
    await withTenant(t.connection.db, b.organizationId, (tx) =>
      postStockMovements(tx, [
        {
          organizationId: b.organizationId,
          storeId,
          variantId: b.apex,
          movementType: 'opening',
          quantity: 10,
        },
      ]),
    );
    ok(await owner().post(`/quotations/${quoted.id}/send`));
    const order = ok(
      await owner().post(`/quotations/${quoted.id}/convert`, { paymentTerms: 'prepaid' }),
    ).json<SalesOrderView>();
    ok(await owner().post(`/sales-orders/${order.id}/confirm`, {}));
    const bill = ok(await owner().post(`/sales-orders/${order.id}/invoices`, {})).json<{
      kind: string;
    }>();
    expect(bill.kind).toBe('bill_of_supply');
  });
});

describe('a quotation through its versions', () => {
  it('edits a draft, sends it, revises it as v2 and keeps v1 read-only', async () => {
    const draft = await create();
    const edited = ok(
      await owner().put(
        `/quotations/${draft.id}`,
        quote({ lines: [{ variantId: b.apex, quantity: 3 }] }),
      ),
    ).json<QuotationView>();
    expect(edited.totalPaise).toBe(35_400);

    const sent = ok(await owner().post(`/quotations/${draft.id}/send`)).json<QuotationView>();
    expect(sent.status).toBe('sent');
    expect(sent.sentAt).not.toBeNull();
    expect((await owner().post(`/quotations/${draft.id}/send`)).statusCode).toBe(409);
    expect((await owner().put(`/quotations/${draft.id}`, quote())).statusCode).toBe(409);
    expect((await owner().delete(`/quotations/${draft.id}`)).statusCode).toBe(409);

    const accepted = ok(await owner().post(`/quotations/${draft.id}/accept`)).json<QuotationView>();
    expect(accepted).toMatchObject({ status: 'accepted', acceptedAt: expect.any(String) });
    expect((await owner().post(`/quotations/${draft.id}/accept`)).statusCode).toBe(409);

    const v2 = ok(await owner().post(`/quotations/${draft.id}/revise`)).json<QuotationView>();
    expect(v2).toMatchObject({
      number: draft.number,
      version: 2,
      rootQuotationId: draft.id,
      status: 'draft',
      totalPaise: 35_400,
      validUntil: await plusDays(15),
      versions: [
        { id: draft.id, version: 1, status: 'superseded' },
        { id: v2.id, version: 2, status: 'draft' },
      ],
    });
    expect(ok(await owner().get(`/quotations/${draft.id}`)).json<QuotationView>().status).toBe(
      'superseded',
    );
    expect((await owner().post(`/quotations/${draft.id}/revise`)).statusCode).toBe(409);
    expect((await owner().post(`/quotations/${v2.id}/revise`)).statusCode).toBe(409);
    // A revision is changed, never discarded.
    expect((await owner().delete(`/quotations/${v2.id}`)).statusCode).toBe(409);

    // v3 from a sent v2 points at the first version too.
    ok(await owner().post(`/quotations/${v2.id}/send`));
    const v3 = ok(await owner().post(`/quotations/${v2.id}/revise`)).json<QuotationView>();
    expect(v3).toMatchObject({ version: 3, rootQuotationId: draft.id });
  });

  it('discards a first draft', async () => {
    const draft = await create();
    expect((await owner().delete(`/quotations/${draft.id}`)).statusCode).toBe(204);
    expect((await owner().get(`/quotations/${draft.id}`)).statusCode).toBe(404);
  });

  it('reads a quote past its validity as expired: not accepted or converted, only revised', async () => {
    const draft = await create();
    const pastDue = await plusDays(-1);
    await t.connection.db.execute(
      sql`update quotations set valid_until = ${pastDue}::date where id = ${draft.id}`,
    );
    expect((await owner().post(`/quotations/${draft.id}/send`)).statusCode).toBe(409);
    await t.connection.db.execute(
      sql`update quotations set status = 'sent', sent_at = now() where id = ${draft.id}`,
    );

    expect(ok(await owner().get(`/quotations/${draft.id}`)).json<QuotationView>()).toMatchObject({
      status: 'expired',
      versions: [{ status: 'expired' }],
    });
    expect((await owner().post(`/quotations/${draft.id}/accept`)).statusCode).toBe(409);
    const convert = await owner().post(`/quotations/${draft.id}/convert`, {
      paymentTerms: 'postpaid',
    });
    expect(convert.statusCode).toBe(409);
    expect(convert.json<{ message: string }>().message).toContain('revise it first');
    expect(
      ok(await owner().post(`/quotations/${draft.id}/revise`)).json<QuotationView>().status,
    ).toBe('draft');
  });
});

describe('POST /quotations/:id/convert', () => {
  it('turns a sent quote into a draft order at today’s prices, once', async () => {
    const draft = await create({
      influencerPartyId: painter,
      projectId: site,
      billDiscount: { kind: 'percent', basisPoints: 500 },
      lines: [{ variantId: b.apex, quantity: 2, discount: { kind: 'amount', paise: 100 } }],
    });
    ok(await owner().post(`/quotations/${draft.id}/send`));
    expect(
      (await owner().post(`/quotations/${draft.id}/convert`, { paymentTerms: 'later' })).statusCode,
    ).toBe(400);
    const headers = { 'idempotency-key': `convert-${draft.id}` };
    const body = { paymentTerms: 'postpaid', fulfilStoreId: b.stores.kkp, note: 'Deliver Monday' };
    const order = ok(
      await api(t, b.owner, headers).post(`/quotations/${draft.id}/convert`, body),
    ).json<SalesOrderView>();

    expect(order).toMatchObject({
      number: expect.stringMatching(/^SO-\d{6}$/),
      status: 'draft',
      paymentTerms: 'postpaid',
      quotationId: draft.id,
      quotationNumber: draft.number,
      billTo: { id: b.parties.homeowner },
      influencer: { id: painter },
      project: { id: site },
      shipTo: { stateCode: '37' },
      billDiscountBps: 500,
      totalPaise: draft.totalPaise,
      note: 'Deliver Monday',
    });
    expect(order.lines).toEqual([
      expect.objectContaining({ variantId: b.apex, quantity: 2, fulfilStoreId: b.stores.kkp }),
    ]);
    expect(
      ok(
        await api(t, b.owner, headers).post(`/quotations/${draft.id}/convert`, body),
      ).json<SalesOrderView>().id,
    ).toBe(order.id);

    expect(ok(await owner().get(`/quotations/${draft.id}`)).json<QuotationView>()).toMatchObject({
      status: 'converted',
      salesOrderId: order.id,
    });
    expect(
      (await owner().post(`/quotations/${draft.id}/convert`, { paymentTerms: 'prepaid' }))
        .statusCode,
    ).toBe(409);
    expect((await owner().post(`/quotations/${draft.id}/revise`)).statusCode).toBe(409);
    expect(
      (
        await owner().post(`/quotations/${(await create()).id}/convert`, {
          paymentTerms: 'prepaid',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('carries a ship-to of a state alone over to the order', async () => {
    const draft = await create({ shipTo: { stateCode: '36' } });
    ok(await owner().post(`/quotations/${draft.id}/send`));
    const order = ok(
      await owner().post(`/quotations/${draft.id}/convert`, { paymentTerms: 'postpaid' }),
    ).json<SalesOrderView>();
    expect(order.shipTo).toEqual({ name: null, address: null, stateCode: '36' });
  });

  it('converts an accepted quote with no ship-to, the order keeping the quote’s note', async () => {
    const draft = await create({ note: 'From the quote' });
    ok(await owner().post(`/quotations/${draft.id}/send`));
    ok(await owner().post(`/quotations/${draft.id}/accept`));
    const order = ok(
      await owner().post(`/quotations/${draft.id}/convert`, { paymentTerms: 'prepaid' }),
    ).json<SalesOrderView>();
    expect(order).toMatchObject({
      note: 'From the quote',
      shipTo: { stateCode: null },
      paymentTerms: 'prepaid',
    });
    expect(order.lines[0]?.fulfilStoreId).toBe(b.stores.amp);
  });
});

describe('GET /quotations/:id/pdf', () => {
  const textOf = async (body: Buffer) =>
    (await extractText(await getDocumentProxy(new Uint8Array(body)))).text
      .join(' ')
      .replace(/\s+/g, ' ');

  it('draws the quotation as an A4 PDF for members who may read it', async () => {
    const created = await create({
      influencerPartyId: painter,
      projectId: site,
      note: 'Two coats',
    });
    const reply = ok(await owner().get(`/quotations/${created.id}/pdf`));
    expect(reply.headers['content-type']).toBe('application/pdf');
    expect(reply.headers['content-disposition']).toContain(`${created.number}-v1.pdf`);
    expect(reply.headers['cache-control']).toBe('private, no-store');
    const text = await textOf(reply.rawPayload);
    for (const expected of [
      'Quotation',
      `${created.number} v1`,
      'Valid until',
      'Suresh',
      'Suresh villa',
      'Plot 4, Beach Road',
      'Ravi Painter',
      'Apex Ultima 1 l',
      'IGST',
      'Two coats',
      'This is a quotation, not a tax invoice.',
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain('Tax Invoice');

    const hindi = ok(await owner().get(`/quotations/${created.id}/pdf?lang=hi`));
    expect(await textOf(hindi.rawPayload)).toContain('पेज 1 / 1');
    expect(issuesOf(await owner().get(`/quotations/${created.id}/pdf?lang=fr`))).toEqual(['lang']);
    // Never to a member of another store, nor for a quote that is not there.
    const kukatpally = await b.member('sales_executive', [b.stores.kkp]);
    expect((await api(t, kukatpally).get(`/quotations/${created.id}/pdf`)).statusCode).toBe(404);
    expect((await owner().get(`/quotations/${crypto.randomUUID()}/pdf`)).statusCode).toBe(404);
  });
});

describe('GET /quotations', () => {
  it('lists the latest version of each quote, newest first, with filters', async () => {
    const fresh = await billingBusiness(t);
    const o = api(t, fresh.owner);
    const make = async (body: object) =>
      ok(
        await o.post('/quotations', {
          storeId: fresh.stores.amp,
          billToPartyId: fresh.parties.homeowner,
          lines: [{ variantId: fresh.apex, quantity: 1 }],
          ...body,
        }),
      ).json<QuotationView>();
    const first = await make({});
    ok(await o.post(`/quotations/${first.id}/send`));
    const revised = ok(await o.post(`/quotations/${first.id}/revise`)).json<QuotationView>();
    const accepted = await make({ billToPartyId: fresh.parties.contractor });
    ok(await o.post(`/quotations/${accepted.id}/send`));
    ok(await o.post(`/quotations/${accepted.id}/accept`));
    const kukatpally = await make({ storeId: fresh.stores.kkp });
    const expired = await make({});
    await t.connection.db.execute(
      sql`update quotations set status = 'sent', sent_at = now(), valid_until = ${await plusDays(-2)}::date where id = ${expired.id}`,
    );
    const list = async (query = '', token = fresh.owner) =>
      ok(await api(t, token).get(`/quotations${query}`)).json<QuotationPage>();
    const ids = (page: QuotationPage) => page.items.map((item) => item.id);

    expect(ids(await list())).toEqual([expired.id, kukatpally.id, accepted.id, revised.id]);
    expect((await list()).total).toBe(4);
    expect(ids(await list('?allVersions=true'))).toEqual([
      expired.id,
      kukatpally.id,
      accepted.id,
      revised.id,
      first.id,
    ]);
    expect(ids(await list('?status=expired'))).toEqual([expired.id]);
    expect((await list('?status=expired')).items[0]?.status).toBe('expired');
    expect(ids(await list('?status=accepted'))).toEqual([accepted.id]);
    expect(ids(await list('?status=sent'))).toEqual([]);
    expect(ids(await list('?status=draft'))).toEqual([kukatpally.id, revised.id]);
    expect(ids(await list(`?partyId=${fresh.parties.contractor}`))).toEqual([accepted.id]);
    expect(ids(await list(`?storeId=${fresh.stores.kkp}`))).toEqual([kukatpally.id]);
    expect(ids(await list(`?projectId=${crypto.randomUUID()}`))).toEqual([]);
    expect(ids(await list('?q=deccan'))).toEqual([accepted.id]);
    expect(ids(await list(`?q=${first.number}`))).toEqual([revised.id]);
    expect(ids(await list('?limit=1&offset=1'))).toEqual([kukatpally.id]);
    expect((await list('?limit=1&offset=1')).items[0]).toMatchObject({
      number: kukatpally.number,
      billToName: 'Suresh',
      totalPaise: 11_800,
    });

    // A member sees the quotes of their stores only, and reads others as not found.
    const atKukatpally = await fresh.member('store_employee', [fresh.stores.kkp]);
    expect(ids(await list('', atKukatpally))).toEqual([kukatpally.id]);
    expect((await api(t, atKukatpally).get(`/quotations/${first.id}`)).statusCode).toBe(404);
  });
});
