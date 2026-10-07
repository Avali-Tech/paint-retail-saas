import { migrateDatabase } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { multipartBody, PDF, testBucket } from '../test-support/files.js';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

// GET /documents without a record: documents on every record the member can
// see, as record-access.ts decides for one record, with filters and paging.

interface Item {
  id: string;
  recordType: string;
  recordId: string;
  recordLabel: string;
  category: string;
  fileName: string;
  uploadedBy: { memberId: string; name: string };
}
interface Page {
  items: Item[];
  total: number;
}

let database: TestDatabase;
let t: TestApp;
const tokens = { owner: '', manager: '', salesPun: '', cashier: '', other: '' };
const members: Record<string, string> = {};
const records: Record<string, string> = {};

const get = (token: string, url: string) =>
  t.app.inject({ method: 'GET', url, headers: bearer(token) });
const post = (token: string, url: string, payload: object) =>
  t.app.inject({ method: 'POST', url, headers: bearer(token), payload });
const idOf = async (response: ReturnType<typeof post>) =>
  (await response).json<{ id: string }>().id;
const browse = async (token: string, query = '') =>
  (await get(token, `/documents${query === '' ? '' : `?${query}`}`)).json<Page>();
/** File names, which are named after their records. */
const names = (page: Page) => page.items.map((item) => item.fileName.replace('.pdf', '')).sort();

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const yesterday = () =>
  new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

async function attach(token: string, recordType: string, record: string, category = 'other') {
  const { payload, headers } = multipartBody(
    { recordType, recordId: String(records[record]), category },
    [{ fileName: `${record}.pdf`, data: PDF }],
  );
  const response = await t.app.inject({
    method: 'POST',
    url: '/documents',
    headers: { ...bearer(token), ...headers },
    payload,
  });
  if (response.statusCode !== 201) throw new Error(response.body);
  return response.json<{ id: string }>().id;
}

async function signup(name: string): Promise<string> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: name,
      fullName: 'Owner',
      phone: uniquePhone(),
      password: 'Staff@2026',
    },
  });
  return response.json<{ token: string }>().token;
}

async function hire(key: keyof typeof tokens, roleKey: string, storeIds: string[]) {
  const roles = (await get(tokens.owner, '/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  members[key] = await idOf(
    post(tokens.owner, '/members', {
      fullName: `Staff ${key}`,
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
  tokens[key] = login.json<{ token: string }>().token;
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  const env = await testBucket(
    inject('objectStorageEndpoint'),
    inject('virusScannerAddress'),
    'documents-browse',
  );
  t = await startTestApp(database.connectionString, env);
  tokens.owner = await signup('Browse Paints');
  const owner = tokens.owner;
  records.hyd = await idOf(post(owner, '/stores', { name: 'Hyderabad', code: 'HYD' }));
  records.pune = await idOf(post(owner, '/stores', { name: 'Pune', code: 'PUN' }));
  await hire('manager', 'branch_manager', [records.hyd]);
  await hire('salesPun', 'sales_executive', [records.pune]);
  await hire('cashier', 'store_employee', [records.hyd]);
  records.supplier = await idOf(
    post(owner, '/parties', {
      kind: 'organization',
      displayName: 'Asian Depot',
      roles: ['supplier'],
    }),
  );
  records.hydCustomer = await idOf(
    post(owner, '/parties', {
      displayName: 'Hyd Customer',
      phone: uniquePhone(),
      homeStoreId: records.hyd,
      roles: ['customer'],
    }),
  );
  records.puneCustomer = await idOf(
    post(owner, '/parties', {
      displayName: 'Pune Customer',
      phone: uniquePhone(),
      homeStoreId: records.pune,
      roles: ['customer'],
    }),
  );
  const brandId = await idOf(post(owner, '/brands', { name: 'Asian Paints' }));
  const product = (
    await post(owner, '/products', {
      brandId,
      name: 'Apex',
      type: 'exterior_paint',
      hsnCode: '3209',
      variants: [{ sku: 'APX-1L', packSize: 1, unit: 'l' }],
    })
  ).json<{ id: string; variants: { id: string }[] }>();
  records.product = product.id;
  const line = [{ variantId: String(product.variants[0]?.id), quantity: 1 }];
  records.hydOrder = await idOf(
    post(owner, '/purchase-orders', {
      supplierId: records.supplier,
      storeId: records.hyd,
      lines: line,
    }),
  );
  records.puneOrder = await idOf(
    post(owner, '/purchase-orders', {
      supplierId: records.supplier,
      storeId: records.pune,
      lines: line,
    }),
  );
  records.receipt = await idOf(
    post(owner, '/goods-receipts', {
      storeId: records.hyd,
      supplierId: records.supplier,
      supplierInvoiceNumber: 'AP-1',
      lines: line,
    }),
  );
  records.transfer = await idOf(
    post(owner, '/transfers', { fromStoreId: records.pune, toStoreId: records.hyd, lines: line }),
  );
  records.puneCount = await idOf(post(owner, '/stock-counts', { storeId: records.pune }));
  const lead = (storeId: string, title: string) =>
    idOf(post(owner, '/leads', { storeId, partyId: records.supplier, title, source: 'walk_in' }));
  records.lead = await lead(records.hyd, 'Repaint');
  records.puneLead = await lead(records.pune, 'Pune job');
  records.opportunity = await idOf(
    post(owner, '/opportunities', {
      storeId: records.hyd,
      partyId: records.supplier,
      title: 'Showroom repaint',
      expectedValuePaise: 100,
    }),
  );
  records.project = await idOf(
    post(owner, '/projects', {
      storeId: records.hyd,
      customerPartyId: records.supplier,
      name: 'Showroom',
    }),
  );
  const contract = (title: string, storeId?: string) =>
    idOf(
      post(owner, '/contracts', {
        type: 'supplier_agreement',
        title,
        partyId: records.supplier,
        startDate: '2026-04-01',
        endDate: '2027-03-31',
        ...(storeId === undefined ? {} : { storeId }),
      }),
    );
  records.contract = await contract('Distribution 2026-27');
  records.puneContract = await contract('Pune rates', records.pune);

  await attach(tokens.manager, 'party', 'supplier', 'cancelled_cheque');
  await attach(owner, 'party', 'hydCustomer', 'gst_certificate');
  await attach(owner, 'party', 'puneCustomer', 'pan_card');
  await attach(owner, 'product', 'product', 'photo');
  await attach(owner, 'store', 'pune', 'photo');
  await attach(owner, 'purchase_order', 'hydOrder', 'quotation');
  await attach(owner, 'purchase_order', 'puneOrder', 'quotation');
  await attach(owner, 'goods_receipt', 'receipt', 'invoice');
  await attach(owner, 'transfer', 'transfer', 'delivery_challan');
  await attach(owner, 'stock_count', 'puneCount');
  await attach(tokens.manager, 'lead', 'lead', 'quotation');
  records.puneLeadDocument = await attach(owner, 'lead', 'puneLead', 'quotation');
  await attach(owner, 'opportunity', 'opportunity', 'quotation');
  await attach(owner, 'project', 'project', 'before_photo');
  await attach(owner, 'contract', 'contract', 'contract');
  await attach(owner, 'contract', 'puneContract', 'contract');

  tokens.other = await signup('Other Paints');
  const otherParty = await idOf(
    post(tokens.other, '/parties', { displayName: 'Other Party', roles: ['customer'] }),
  );
  records.otherParty = otherParty;
  await attach(tokens.other, 'party', 'otherParty');
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('documents across records', () => {
  it('lists every document the member can see, newest first, naming each record', async () => {
    const all = await browse(tokens.owner);

    expect(all.total).toBe(16);
    expect(all.items[0]?.fileName).toBe('puneContract.pdf');
    expect(all.items.find((item) => item.fileName === 'lead.pdf')).toMatchObject({
      recordType: 'lead',
      recordId: records.lead,
      recordLabel: expect.stringMatching(/^LD-\d{6} · Repaint$/),
      uploadedBy: { memberId: members.manager, name: 'Staff manager' },
    });
    const labels = Object.fromEntries(all.items.map((item) => [item.fileName, item.recordLabel]));
    expect(labels).toMatchObject({
      'supplier.pdf': 'Asian Depot',
      'product.pdf': 'Apex',
      'pune.pdf': 'PUN · Pune',
      'hydOrder.pdf': expect.stringMatching(/^PO-\d{6}$/),
      'receipt.pdf': expect.stringMatching(/^GRN-\d{6}$/),
      'transfer.pdf': expect.stringMatching(/^TR-\d{6}$/),
      'puneCount.pdf': expect.stringMatching(/^SC-\d{6}$/),
      'opportunity.pdf': expect.stringMatching(/^OP-\d{6} · Showroom repaint$/),
      'project.pdf': expect.stringMatching(/^PJ-\d{6} · Showroom$/),
      'contract.pdf': expect.stringMatching(/^CT-\d{6} · Distribution 2026-27$/),
    });
    expect(names(await browse(tokens.other))).toEqual(['otherParty']);
  });

  it('shows each role only the records it can see, at its stores', async () => {
    expect(names(await browse(tokens.manager))).toEqual([
      'contract',
      'hydCustomer',
      'hydOrder',
      'lead',
      'opportunity',
      'product',
      'project',
      'receipt',
      'supplier',
      'transfer',
    ]);
    // No purchasing for sales; the transfer touches Pune, so Pune sees it too.
    expect(names(await browse(tokens.salesPun))).toEqual([
      'contract',
      'product',
      'pune',
      'puneContract',
      'puneCount',
      'puneCustomer',
      'puneLead',
      'supplier',
      'transfer',
    ]);
    expect(names(await browse(tokens.cashier))).toEqual([
      'hydCustomer',
      'product',
      'supplier',
      'transfer',
    ]);
  });

  it('filters by record type, category, uploader and India-time day, and pages', async () => {
    const list = (query: string) => browse(tokens.owner, query);

    expect(names(await list('recordType=party'))).toEqual([
      'hydCustomer',
      'puneCustomer',
      'supplier',
    ]);
    expect(names(await list('category=contract'))).toEqual(['contract', 'puneContract']);
    expect(names(await list(`uploadedBy=${String(members.manager)}`))).toEqual([
      'lead',
      'supplier',
    ]);
    expect(names(await browse(tokens.manager, 'uploadedBy=me'))).toEqual(['lead', 'supplier']);
    expect((await list(`from=${today()}&to=${today()}`)).total).toBe(16);
    expect((await list(`to=${yesterday()}`)).total).toBe(0);
    const second = await list('limit=2&offset=1');
    expect(second.total).toBe(16);
    expect(second.items.map((item) => item.fileName)).toEqual(['contract.pdf', 'project.pdf']);
    expect(names(await browse(tokens.cashier, 'recordType=lead'))).toEqual([]);
  });

  it('leaves out deleted documents', async () => {
    await t.app.inject({
      method: 'DELETE',
      url: `/documents/${String(records.puneLeadDocument)}`,
      headers: bearer(tokens.owner),
    });

    expect((await browse(tokens.owner)).total).toBe(15);
    expect(names(await browse(tokens.salesPun, 'recordType=lead'))).toEqual([]);
  });

  it.each([
    ['from=2026-10-05&to=2026-10-01', 'to'],
    ['category=menu', 'category'],
    ['uploadedBy=someone', 'uploadedBy'],
    ['recordType=invoice', 'recordType'],
    ['limit=500', 'limit'],
  ])('answers 400 for %s', async (query, field) => {
    const response = await get(tokens.owner, `/documents?${query}`);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ issues: { path: string }[] }>().issues.map((i) => i.path)).toContain(
      field,
    );
  });
});
