import { migrateDatabase } from '@paint/db';
import { lineTintRequest } from '@paint/shared';
import type {
  QuotationView,
  SalesOrderView,
  TaxCategoryOptions,
  TaxDocumentView,
  TintRecordPage,
  TintRecordView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  issuesOf,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
/** The Apex product (tintable here) and a brush (never tinted). */
let apexProduct: string;
let brush: string;
let brandId: string;
let contractorPhone: string;
let site: string;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  const o = api(t, b.owner);
  const apex = ok(await o.get('/products?q=Apex')).json<{
    items: { id: string; brand: { id: string } }[];
  }>().items[0];
  apexProduct = String(apex?.id);
  brandId = String(apex?.brand.id);
  ok(await o.patch(`/products/${apexProduct}`, { isTintable: true, coverageSqftPerLitre: 120 }));
  brush = String(
    ok(
      await o.post('/products', {
        brandId,
        name: 'Brush',
        type: 'tool',
        hsnCode: '96034000',
        taxCategoryId: String(
          ok(await o.get('/tax-categories/options'))
            .json<TaxCategoryOptions>()
            .categories.find((category) => category.key === 'paints')?.id,
        ),
        variants: [{ sku: 'BR-2IN', packSize: 1, unit: 'piece', sellingPricePaise: 9_000 }],
      }),
    ).json<{ variants: { id: string }[] }>().variants[0]?.id,
  );
  contractorPhone = ok(await o.get(`/parties/${b.parties.contractor}`)).json<{
    phone: string;
  }>().phone;
  site = ok(
    await o.post('/projects', {
      storeId: b.stores.amp,
      customerPartyId: b.parties.homeowner,
      name: 'Suresh villa',
      state: 'Telangana',
    }),
  ).json<{ id: string }>().id;
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

const owner = () => api(t, b.owner);
const tint = (body: object, token = b.owner, headers: Record<string, string> = {}) =>
  api(t, token, headers).post('/tint-records', { shadeCode: 'x 132', ...body });
const draftInvoice = (body: object = {}, token = b.owner) =>
  b.draft(
    { partyId: b.parties.contractor, lines: [{ variantId: b.apex, quantity: 2 }], ...body },
    token,
  );
const quote = async (body: object = {}) =>
  ok(
    await owner().post('/quotations', {
      storeId: b.stores.amp,
      billToPartyId: b.parties.homeowner,
      projectId: site,
      lines: [
        { variantId: b.apex, quantity: 4 },
        { variantId: brush, quantity: 1 },
      ],
      ...body,
    }),
  ).json<QuotationView>();
const lineOf = (document: { lines: readonly { id: string }[] }, index = 0) =>
  String(document.lines[index]?.id);
const search = async (query: string, token = b.owner) =>
  ok(await api(t, token).get(`/tint-records?${query}`)).json<TintRecordPage>();

describe('a repeat order at another store (spec §7 round 5 demo)', () => {
  it('finds at Kukatpally the shade billed at Ameerpet', async () => {
    const invoice = await draftInvoice();
    const created = ok(
      await tint({
        lineKind: 'invoice_line',
        lineId: lineOf(invoice),
        shadeName: 'Moon Mist',
        colorantCostPaise: 4_500,
        tintChargePaise: 2_000,
        machine: 'Colour World 2',
        formula: [
          { colorant: 'XY', amount: 1.25, unit: 'ml' },
          { colorant: 'RO', amount: 3, unit: 'shot' },
        ],
        note: 'Second coat a shade lighter',
      }),
    ).json<TintRecordView>();
    expect(created).toMatchObject({
      lineKind: 'invoice_line',
      lineId: lineOf(invoice),
      document: { kind: 'invoice', id: invoice.id, number: null, status: 'draft' },
      store: { id: b.stores.amp, name: 'Ameerpet' },
      party: { id: b.parties.contractor, name: 'Deccan Contractors', phone: contractorPhone },
      project: null,
      brand: { id: brandId, name: 'Asian Paints' },
      shadeCode: 'X 132',
      shadeName: 'Moon Mist',
      baseVariant: {
        id: b.apex,
        productId: apexProduct,
        sku: 'APX-1L',
        description: 'Apex Ultima 1 l',
        isActive: true,
      },
      packQuantity: 2,
      colorantCostPaise: 4_500,
      tintChargePaise: 2_000,
      machine: 'Colour World 2',
      formula: [
        { colorant: 'XY', amount: 1.25, unit: 'ml' },
        { colorant: 'RO', amount: 3, unit: 'shot' },
      ],
      note: 'Second coat a shade lighter',
    });
    ok(await owner().post(`/invoices/${invoice.id}/issue`, {}));

    // A Kukatpally salesperson, who cannot see Ameerpet, looks the contractor up by mobile.
    const kukatpally = await b.member('sales_executive', [b.stores.kkp]);
    const found = await search(`q=${contractorPhone.slice(3)}&billed=true`, kukatpally);
    expect(found.total).toBe(1);
    expect(found.items[0]).toMatchObject({
      id: created.id,
      shadeCode: 'X 132',
      store: { name: 'Ameerpet' },
      document: { kind: 'invoice', status: 'issued', number: expect.stringMatching(/^AMP\//) },
    });
    expect(found.items[0]?.document.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The same by party and shade (normalised), and by part of the shade's name.
    expect((await search(`partyId=${b.parties.contractor}&shadeCode=x132`, kukatpally)).total).toBe(
      0,
    );
    expect(
      (await search(`partyId=${b.parties.contractor}&shadeCode=%20x%20132`, kukatpally)).items.map(
        (item) => item.id,
      ),
    ).toEqual([created.id]);
    expect((await search('q=moon', kukatpally)).items.map((item) => item.id)).toContain(created.id);
    expect(ok(await api(t, kukatpally).get(`/tint-records/${created.id}`)).json()).toEqual(
      found.items[0],
    );
    // The invoice itself stays at its store.
    expect((await api(t, kukatpally).get(`/invoices/${invoice.id}`)).statusCode).toBe(404);
  });
});

describe('POST /tint-records', () => {
  it('tints a quotation line with the line’s party, site and store, once', async () => {
    const quotation = await quote();
    const headers = { 'idempotency-key': 'tint-1' };
    const body = { lineKind: 'quotation_line', lineId: lineOf(quotation), packQuantity: 3 };
    const first = ok(await tint(body, b.owner, headers)).json<TintRecordView>();
    expect(first).toMatchObject({
      document: { kind: 'quotation', id: quotation.id, number: quotation.number, status: 'draft' },
      party: { id: b.parties.homeowner, name: 'Suresh' },
      project: { id: site, name: 'Suresh villa' },
      packQuantity: 3,
      colorantCostPaise: null,
      tintChargePaise: 0,
      machine: null,
      formula: [],
      shadeName: null,
    });
    // A retry is the same record; tinting the line again is refused.
    expect(ok(await tint(body, b.owner, headers)).json<TintRecordView>().id).toBe(first.id);
    const again = await tint(body);
    expect(again.statusCode).toBe(409);
    expect(again.json<{ message: string }>().message).toBe(
      'This line is already tinted: remove its tint first',
    );
  });

  it('refuses what cannot be tinted', async () => {
    const quotation = await quote();
    const refused = async (body: object, status: number, token = b.owner) => {
      const reply = await tint(
        { lineKind: 'quotation_line', lineId: lineOf(quotation), ...body },
        token,
      );
      expect(reply.statusCode).toBe(status);
      return reply;
    };
    expect(issuesOf(await refused({ lineId: lineOf(quotation, 1) }, 400))).toEqual(['lineId']);
    expect(issuesOf(await refused({ packQuantity: 5 }, 400))).toEqual(['packQuantity']);
    expect(issuesOf(await refused({ brandId: crypto.randomUUID() }, 400))).toEqual(['brandId']);
    expect(issuesOf(await refused({ shadeCode: '   ' }, 400))).toEqual(['shadeCode']);
    expect(issuesOf(await refused({ shadeCode: 'X'.repeat(41) }, 400))).toEqual(['shadeCode']);
    expect(
      issuesOf(await refused({ formula: [{ colorant: 'XY', amount: 0.0001, unit: 'ml' }] }, 400)),
    ).toEqual(['formula.0.amount']);
    expect(issuesOf(await refused({ lineKind: 'note_line' }, 400))).toEqual(['lineKind']);
    await refused({ lineId: crypto.randomUUID() }, 404);
    // A store employee bills (invoice lines) but does not write quotations.
    const employee = await b.member('store_employee', [b.stores.amp]);
    await refused({}, 403, employee);
    // A Kukatpally salesperson does not see an Ameerpet quotation.
    const kukatpally = await b.member('sales_executive', [b.stores.kkp]);
    await refused({}, 404, kukatpally);
    // Another brand's shade card is fine.
    const other = ok(await owner().post('/brands', { name: 'Nerolac' })).json<{ id: string }>().id;
    expect(
      ok(
        await tint({ lineKind: 'quotation_line', lineId: lineOf(quotation), brandId: other }),
      ).json<TintRecordView>().brand,
    ).toEqual({ id: other, name: 'Nerolac' });

    // Once sent, the quotation's lines are history.
    const sent = await quote();
    ok(await owner().post(`/quotations/${sent.id}/send`));
    const reply = await tint({ lineKind: 'quotation_line', lineId: lineOf(sent) });
    expect(reply.statusCode).toBe(409);
    expect(reply.json<{ message: string }>().message).toBe(
      "This quotation is sent: only a draft's lines are tinted or untinted",
    );
  });

  it('lets a store employee tint an invoice line at the counter', async () => {
    const employee = await b.member('store_employee', [b.stores.amp]);
    const invoice = await draftInvoice({ partyId: undefined }, employee);
    const created = ok(
      await tint(
        { lineKind: 'invoice_line', lineId: lineOf(invoice), shadeCode: 'L104' },
        employee,
      ),
    ).json<TintRecordView>();
    expect(created).toMatchObject({
      party: null,
      shadeCode: 'L104',
      createdByMemberId: expect.any(String),
    });
    // Shade history is read with sales:read.
    expect((await search(`documentKind=invoice&documentId=${invoice.id}`, employee)).total).toBe(1);
  });
});

describe('carrying a shade with the lines', () => {
  it('goes from the quote to its revision, its order and the bill from the order', async () => {
    const quotation = await quote({ lines: [{ variantId: b.apex, quantity: 4 }] });
    ok(
      await tint({
        lineKind: 'quotation_line',
        lineId: lineOf(quotation),
        shadeCode: 'N 2',
        tintChargePaise: 1_500,
      }),
    );
    ok(await owner().post(`/quotations/${quotation.id}/send`));
    const revised = ok(
      await owner().post(`/quotations/${quotation.id}/revise`),
    ).json<QuotationView>();
    const onRevision = await search(`documentKind=quotation&documentId=${revised.id}`);
    expect(onRevision.items).toEqual([
      expect.objectContaining({
        lineKind: 'quotation_line',
        lineId: lineOf(revised),
        shadeCode: 'N 2',
        packQuantity: 4,
        tintChargePaise: 1_500,
        project: { id: site, name: 'Suresh villa' },
      }),
    ]);
    // The first version keeps its own (superseded) record.
    expect((await search(`documentKind=quotation&documentId=${quotation.id}`)).total).toBe(1);

    ok(await owner().post(`/quotations/${revised.id}/send`));
    const order = ok(
      await owner().post(`/quotations/${revised.id}/convert`, {
        paymentTerms: 'prepaid',
        fulfilStoreId: b.stores.kkp,
      }),
    ).json<SalesOrderView>();
    const onOrder = await search(`documentKind=sales_order&documentId=${order.id}`);
    expect(onOrder.items).toEqual([
      expect.objectContaining({
        lineKind: 'sales_order_line',
        lineId: lineOf(order),
        store: { id: b.stores.kkp, name: 'Kukatpally' },
        party: expect.objectContaining({ id: b.parties.homeowner }),
        packQuantity: 4,
      }),
    ]);

    ok(await owner().post(`/sales-orders/${order.id}/confirm`));
    const bill = ok(
      await owner().post(`/sales-orders/${order.id}/invoices`, {
        lines: [{ orderLineId: lineOf(order), quantity: 1.5 }],
      }),
    ).json<TaxDocumentView>();
    const onBill = await search(`documentKind=invoice&documentId=${bill.id}`);
    expect(onBill.items).toEqual([
      expect.objectContaining({
        lineKind: 'invoice_line',
        lineId: lineOf(bill),
        store: { id: b.stores.kkp, name: 'Kukatpally' },
        // Only the packs billed are tinted on the bill.
        packQuantity: 1.5,
        shadeCode: 'N 2',
      }),
    ]);
    // Everything about this site, newest first.
    expect(
      (await search(`projectId=${site}&shadeCode=N%202`)).items.map((item) => item.document.kind),
    ).toEqual(['invoice', 'sales_order', 'quotation', 'quotation']);
  });

  it('copies nothing for untinted lines', async () => {
    const quotation = await quote();
    ok(await owner().post(`/quotations/${quotation.id}/send`));
    const revised = ok(
      await owner().post(`/quotations/${quotation.id}/revise`),
    ).json<QuotationView>();
    expect((await search(`documentKind=quotation&documentId=${revised.id}`)).total).toBe(0);
  });
});

describe('DELETE /tint-records/:id', () => {
  it('untints a draft’s line, never an issued one', async () => {
    const invoice = await draftInvoice();
    const record = ok(
      await tint({ lineKind: 'invoice_line', lineId: lineOf(invoice) }),
    ).json<TintRecordView>();
    expect((await owner().delete(`/tint-records/${record.id}`)).statusCode).toBe(204);
    expect((await owner().get(`/tint-records/${record.id}`)).statusCode).toBe(404);
    expect((await owner().delete(`/tint-records/${record.id}`)).statusCode).toBe(404);

    const again = ok(
      await tint({ lineKind: 'invoice_line', lineId: lineOf(invoice) }),
    ).json<TintRecordView>();
    ok(await owner().post(`/invoices/${invoice.id}/issue`, {}));
    const refused = await owner().delete(`/tint-records/${again.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ message: string }>().message).toBe(
      "This invoice is issued: only a draft's lines are tinted or untinted",
    );
  });

  it('goes with the lines when a draft is changed', async () => {
    const quotation = await quote();
    const record = ok(
      await tint({ lineKind: 'quotation_line', lineId: lineOf(quotation) }),
    ).json<TintRecordView>();
    ok(
      await owner().put(`/quotations/${quotation.id}`, {
        storeId: b.stores.amp,
        billToPartyId: b.parties.homeowner,
        lines: [{ variantId: b.apex, quantity: 1 }],
      }),
    );
    expect((await owner().get(`/tint-records/${record.id}`)).statusCode).toBe(404);
  });

  it('untints an order line at the order’s fulfil store', async () => {
    const order = ok(
      await owner().post('/sales-orders', {
        storeId: b.stores.amp,
        billToPartyId: b.parties.homeowner,
        paymentTerms: 'prepaid',
        lines: [{ variantId: b.apex, quantity: 1, fulfilStoreId: b.stores.kkp }],
      }),
    ).json<SalesOrderView>();
    const kukatpally = await b.member('sales_executive', [b.stores.kkp]);
    const record = ok(
      await tint({ lineKind: 'sales_order_line', lineId: lineOf(order) }, kukatpally),
    ).json<TintRecordView>();
    expect(record.store).toEqual({ id: b.stores.kkp, name: 'Kukatpally' });
    expect((await api(t, kukatpally).delete(`/tint-records/${record.id}`)).statusCode).toBe(204);
  });
});

describe('GET /tint-records', () => {
  it('follows a merged party to its survivor', async () => {
    const o = owner();
    const duplicate = ok(
      await o.post('/parties', { displayName: 'Raju', phone: uniquePhone(), roles: ['customer'] }),
    ).json<{ id: string }>().id;
    const survivor = ok(
      await o.post('/parties', {
        displayName: 'Raju Rao',
        phone: uniquePhone(),
        roles: ['customer'],
      }),
    ).json<{ id: string }>().id;
    const quotation = await quote({ billToPartyId: duplicate, projectId: undefined });
    const record = ok(
      await tint({ lineKind: 'quotation_line', lineId: lineOf(quotation), shadeCode: 'R 1' }),
    ).json<TintRecordView>();
    ok(await o.post(`/parties/${duplicate}/merge`, { intoPartyId: survivor }));

    const found = await search(`partyId=${survivor}`);
    expect(found.items.map((item) => item.id)).toEqual([record.id]);
    // The record keeps the party it was made for.
    expect(found.items[0]?.party).toMatchObject({ id: duplicate, name: 'Raju' });
  });

  it('pages newest first and counts every match', async () => {
    const all = await search('limit=2');
    expect(all.items).toHaveLength(2);
    expect(all.total).toBeGreaterThan(5);
    const [newer, older] = all.items;
    expect(String(newer?.createdAt) >= String(older?.createdAt)).toBe(true);
    // Past the end there are no items, but the count is still known.
    expect(await search(`offset=${String(all.total)}`)).toEqual({ items: [], total: all.total });
    expect(await search('q=no-such-shade')).toEqual({ items: [], total: 0 });
    expect(await search('q=no-such-shade&offset=10')).toEqual({ items: [], total: 0 });
    expect(await search(`storeId=${b.stores.unr}`)).toEqual({ items: [], total: 0 });
  });

  it('checks its query', async () => {
    const reply = await owner().get(`/tint-records?documentKind=invoice`);
    expect(reply.statusCode).toBe(400);
    expect(issuesOf(reply)).toEqual(['documentId']);
    expect((await owner().get('/tint-records/not-a-uuid')).statusCode).toBe(400);
  });
});

describe('a tint sent with its line (re-saving a draft keeps the shade)', () => {
  const tinted = (tint: object = {}) => ({
    variantId: b.apex,
    quantity: 4,
    tint: { shadeCode: 'q 9', shadeName: 'Sea Breeze', tintChargePaise: 1_200, ...tint },
  });
  const quoteBody = (lines: object[]) => ({
    storeId: b.stores.amp,
    billToPartyId: b.parties.homeowner,
    projectId: site,
    lines,
  });

  it('keeps a quotation line’s tint on re-save, and drops it when left out', async () => {
    const created = ok(
      await owner().post('/quotations', quoteBody([tinted(), { variantId: brush, quantity: 1 }])),
    ).json<QuotationView>();
    expect(created.lines[0]?.tint).toMatchObject({
      shadeCode: 'Q 9',
      shadeName: 'Sea Breeze',
      brand: { id: brandId, name: 'Asian Paints' },
      packQuantity: 4,
      tintChargePaise: 1_200,
      colorantCostPaise: null,
      machine: null,
      note: null,
      formula: [],
    });
    expect(created.lines[1]?.tint).toBeUndefined();
    // A resumed draft reads its shades back in one call, and re-saves them.
    const read = ok(await owner().get(`/quotations/${created.id}`)).json<QuotationView>();
    const tint = read.lines[0]?.tint;
    if (!tint) throw new Error('Expected the tint inline');
    const resaved = ok(
      await owner().put(
        `/quotations/${created.id}`,
        quoteBody([{ variantId: b.apex, quantity: 5, tint: lineTintRequest(tint) }]),
      ),
    ).json<QuotationView>();
    expect(resaved.lines[0]?.tint).toMatchObject({ shadeCode: 'Q 9', packQuantity: 4 });
    expect(resaved.lines[0]?.tint?.id).not.toBe(tint.id);
    expect((await search(`documentKind=quotation&documentId=${created.id}`)).total).toBe(1);

    const untinted = ok(
      await owner().put(
        `/quotations/${created.id}`,
        quoteBody([{ variantId: b.apex, quantity: 3 }]),
      ),
    ).json<QuotationView>();
    expect(untinted.lines[0]?.tint).toBeUndefined();
    expect((await search(`documentKind=quotation&documentId=${created.id}`)).total).toBe(0);
  });

  it('refuses the whole save when a tint is invalid', async () => {
    const created = ok(
      await owner().post('/quotations', quoteBody([tinted()])),
    ).json<QuotationView>();
    const refused = async (lines: object[]) => {
      const reply = await owner().put(`/quotations/${created.id}`, quoteBody(lines));
      expect(reply.statusCode).toBe(400);
      return issuesOf(reply);
    };
    expect(await refused([tinted(), tinted({ packQuantity: 5 })])).toEqual([
      'lines.1.tint.packQuantity',
    ]);
    expect(await refused([{ variantId: brush, quantity: 1, tint: { shadeCode: 'X' } }])).toEqual([
      'lines.0.tint',
    ]);
    expect(await refused([tinted({ brandId: crypto.randomUUID() })])).toEqual([
      'lines.0.tint.brandId',
    ]);
    expect(await refused([tinted({ shadeCode: ' ' })])).toEqual(['lines.0.tint.shadeCode']);
    // Nothing changed: same lines, same shade.
    const after = ok(await owner().get(`/quotations/${created.id}`)).json<QuotationView>();
    expect(after.lines).toHaveLength(1);
    expect(after.lines[0]?.tint?.id).toBe(created.lines[0]?.tint?.id);

    // A new quotation with a bad tint is not created at all.
    const before = ok(await owner().get('/quotations?limit=1')).json<{ total: number }>().total;
    expect(
      (await owner().post('/quotations', quoteBody([tinted({ packQuantity: 9 })]))).statusCode,
    ).toBe(400);
    expect(ok(await owner().get('/quotations?limit=1')).json<{ total: number }>().total).toBe(
      before,
    );
  });

  it('keeps an order line’s tint at its fulfil store on re-save', async () => {
    const body = (lines: object[]) => ({
      storeId: b.stores.amp,
      billToPartyId: b.parties.contractor,
      paymentTerms: 'prepaid',
      lines,
    });
    const created = ok(
      await owner().post('/sales-orders', body([{ ...tinted(), fulfilStoreId: b.stores.kkp }])),
    ).json<SalesOrderView>();
    expect(created.lines[0]?.tint?.shadeCode).toBe('Q 9');
    const [record] = (await search(`documentKind=sales_order&documentId=${created.id}`)).items;
    expect(record?.store).toEqual({ id: b.stores.kkp, name: 'Kukatpally' });
    const tint = created.lines[0]?.tint;
    if (!tint) throw new Error('Expected the tint inline');
    const resaved = ok(
      await owner().put(
        `/sales-orders/${created.id}`,
        body([{ variantId: b.apex, quantity: 4, tint: lineTintRequest(tint) }]),
      ),
    ).json<SalesOrderView>();
    expect(resaved.lines[0]?.tint).toMatchObject({ shadeCode: 'Q 9', tintChargePaise: 1_200 });
    expect(
      ok(await owner().get(`/sales-orders/${created.id}`)).json<SalesOrderView>().lines[0]?.tint
        ?.shadeCode,
    ).toBe('Q 9');
  });

  it('keeps a held bill’s tint on resume, and refuses a bad one without saving', async () => {
    const employee = await b.member('store_employee', [b.stores.amp]);
    const held = await b.draft(
      {
        partyId: b.parties.contractor,
        lines: [
          tinted({
            colorantCostPaise: 900,
            machine: 'Colour World 2',
            note: 'Kitchen',
            formula: [{ colorant: 'XY', amount: 2, unit: 'ml' }],
          }),
        ],
      },
      employee,
    );
    const tint = held.lines[0]?.tint;
    if (!tint) throw new Error('Expected the tint inline');
    expect(tint).toMatchObject({
      colorantCostPaise: 900,
      machine: 'Colour World 2',
      note: 'Kitchen',
    });
    const resumed = ok(
      await api(t, employee).put(`/invoices/${held.id}`, {
        storeId: b.stores.amp,
        partyId: b.parties.contractor,
        lines: [{ variantId: b.apex, quantity: 4, tint: lineTintRequest(tint) }],
      }),
    ).json<TaxDocumentView>();
    expect(resumed.lines[0]?.tint).toMatchObject({
      shadeCode: 'Q 9',
      colorantCostPaise: 900,
      formula: [{ colorant: 'XY', amount: 2, unit: 'ml' }],
    });

    const refused = await api(t, employee).put(`/invoices/${held.id}`, {
      storeId: b.stores.amp,
      lines: [{ variantId: b.apex, quantity: 1, tint: { shadeCode: 'Q 9', packQuantity: 2 } }],
    });
    expect(refused.statusCode).toBe(400);
    expect(issuesOf(refused)).toEqual(['lines.0.tint.packQuantity']);
    const kept = ok(await owner().get(`/invoices/${held.id}`)).json<TaxDocumentView>();
    expect(kept.buyer.partyId).toBe(b.parties.contractor);
    expect(kept.lines[0]?.tint?.id).toBe(resumed.lines[0]?.tint?.id);

    // Issued, the shade is read back with the invoice and stays.
    const issued = ok(await owner().post(`/invoices/${held.id}/issue`, {})).json<TaxDocumentView>();
    expect(issued.lines[0]?.tint?.shadeCode).toBe('Q 9');
  });
});
