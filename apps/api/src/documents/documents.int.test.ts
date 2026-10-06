import { createHash } from 'node:crypto';
import { migrateDatabase } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { EICAR, multipartBody, PDF, PNG, testBucket, zipArchive } from '../test-support/files.js';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

interface DocumentView {
  id: string;
  recordType: string;
  recordId: string;
  category: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadedBy: { memberId: string; name: string };
  createdAt: string;
}

let database: TestDatabase;
let t: TestApp;
let owner: string;
let manager: string;
let cashier: string;
const records: Record<string, string> = {};

const api = (token: string, app = () => t) => ({
  get: (url: string) => app().app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object) =>
    app().app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  delete: (url: string) => app().app.inject({ method: 'DELETE', url, headers: bearer(token) }),
});

function upload(
  token: string,
  fields: Record<string, string>,
  files: { fileName: string; data: Buffer; contentType?: string }[],
  app: TestApp = t,
) {
  const { payload, headers } = multipartBody(fields, files);
  return app.app.inject({
    method: 'POST',
    url: '/documents',
    headers: { ...bearer(token), ...headers },
    payload,
  });
}

const attach = (
  token: string,
  recordType: string,
  recordId: string,
  file: { fileName: string; data: Buffer } = { fileName: 'GST Certificate.pdf', data: PDF },
  category = 'gst_certificate',
) => upload(token, { recordType, recordId, category }, [file]);

const listOf = (token: string, recordType: string, recordId: string) =>
  api(token).get(`/documents?recordType=${recordType}&recordId=${recordId}`);

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

async function hire(roleKey: string, storeIds: string[]): Promise<string> {
  const roles = (await api(owner).get('/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  await api(owner).post('/members', {
    fullName: `Staff ${roleKey}`,
    phone,
    password: 'Staff@2026',
    roleId: roles.find((role) => role.key === roleKey)?.id,
    storeIds,
  });
  const login = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier: phone, password: 'Staff@2026' },
  });
  return login.json<{ token: string }>().token;
}

const idOf = async (response: ReturnType<ReturnType<typeof api>['post']>) =>
  (await response).json<{ id: string }>().id;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  const env = await testBucket(
    inject('objectStorageEndpoint'),
    inject('virusScannerAddress'),
    'documents-test',
  );
  t = await startTestApp(database.connectionString, env);
  owner = await signup('ABC Paints');
  const o = api(owner);
  records.hyd = await idOf(o.post('/stores', { name: 'Hyderabad', code: 'HYD' }));
  records.pune = await idOf(o.post('/stores', { name: 'Pune', code: 'PUN' }));
  manager = await hire('branch_manager', [records.hyd]);
  cashier = await hire('store_employee', [records.hyd]);
  records.supplier = await idOf(
    o.post('/parties', { kind: 'organization', displayName: 'Asian Depot', roles: ['supplier'] }),
  );
  records.puneCustomer = await idOf(
    o.post('/parties', {
      displayName: 'Pune Customer',
      phone: uniquePhone(),
      homeStoreId: records.pune,
      roles: ['customer'],
    }),
  );
  const brandId = await idOf(o.post('/brands', { name: 'Asian Paints' }));
  const product = (
    await o.post('/products', {
      brandId,
      name: 'Apex',
      type: 'exterior_paint',
      hsnCode: '3209',
      gstRatePercent: 18,
      variants: [{ sku: 'APX-1L', packSize: 1, unit: 'l' }],
    })
  ).json<{ id: string; variants: { id: string }[] }>();
  records.product = product.id;
  const variantId = String(product.variants[0]?.id);
  const line = [{ variantId, quantity: 1 }];
  records.hydOrder = await idOf(
    o.post('/purchase-orders', { supplierId: records.supplier, storeId: records.hyd, lines: line }),
  );
  records.puneOrder = await idOf(
    o.post('/purchase-orders', {
      supplierId: records.supplier,
      storeId: records.pune,
      lines: line,
    }),
  );
  records.receipt = await idOf(
    o.post('/goods-receipts', {
      storeId: records.hyd,
      supplierId: records.supplier,
      supplierInvoiceNumber: 'AP-1',
      lines: line,
    }),
  );
  records.transfer = await idOf(
    o.post('/transfers', { fromStoreId: records.pune, toStoreId: records.hyd, lines: line }),
  );
  records.puneCount = await idOf(o.post('/stock-counts', { storeId: records.pune }));
  records.lead = await idOf(
    o.post('/leads', {
      storeId: records.hyd,
      partyId: records.supplier,
      title: 'Repaint',
      source: 'walk_in',
    }),
  );
  records.puneLead = await idOf(
    o.post('/leads', {
      storeId: records.pune,
      partyId: records.supplier,
      title: 'Pune job',
      source: 'walk_in',
    }),
  );
  records.opportunity = await idOf(
    o.post('/opportunities', {
      storeId: records.hyd,
      partyId: records.supplier,
      title: 'Showroom repaint',
      expectedValuePaise: 100,
    }),
  );
  records.project = await idOf(
    o.post('/projects', {
      storeId: records.hyd,
      customerPartyId: records.supplier,
      name: 'Showroom',
    }),
  );
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('uploading and downloading', () => {
  it('stores a scanned file against a record and gives back the exact bytes', async () => {
    const response = await upload(
      owner,
      {
        recordType: 'party',
        recordId: String(records.supplier),
        category: 'gst_certificate',
        note: 'Valid till March 2027',
      },
      [{ fileName: 'C:\\scans\\GST Certificate.pdf', data: PDF, contentType: 'text/html' }],
    );

    expect(response.statusCode).toBe(201);
    const document = response.json<DocumentView>();
    expect(document).toMatchObject({
      recordType: 'party',
      recordId: records.supplier,
      category: 'gst_certificate',
      fileName: 'GST Certificate.pdf',
      note: 'Valid till March 2027',
      // From the content, not the type the browser claimed.
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
      sha256: createHash('sha256').update(PDF).digest('hex'),
      uploadedBy: { name: 'Owner' },
    });

    const listed = (await listOf(owner, 'party', String(records.supplier))).json<DocumentView[]>();
    expect(listed).toEqual([document]);

    const download = await api(owner).get(`/documents/${document.id}/download`);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(PDF);
    expect(download.headers).toMatchObject({
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="GST Certificate.pdf"; filename*=UTF-8''GST%20Certificate.pdf`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    });
  });

  it('attaches documents to every kind of record, newest first', async () => {
    for (const [type, key] of [
      ['product', 'product'],
      ['store', 'hyd'],
      ['purchase_order', 'hydOrder'],
      ['goods_receipt', 'receipt'],
      ['transfer', 'transfer'],
      ['stock_count', 'puneCount'],
      ['party', 'puneCustomer'],
      ['lead', 'lead'],
      ['opportunity', 'opportunity'],
      ['project', 'project'],
    ] as const) {
      const recordId = String(records[key]);
      const first = await attach(
        owner,
        type,
        recordId,
        { fileName: 'photo.png', data: PNG },
        'photo',
      );
      const second = await attach(owner, type, recordId);
      expect([type, first.statusCode, second.statusCode]).toEqual([type, 201, 201]);
      const listed = (await listOf(owner, type, recordId)).json<DocumentView[]>();
      expect([type, listed.map((d) => d.category)]).toEqual([type, ['gst_certificate', 'photo']]);
    }
  });
});

describe('who can see and change documents', () => {
  it('shows documents only to members who can see the record', async () => {
    const statuses = async (token: string, pairs: [string, string][]) =>
      Promise.all(
        pairs.map(
          async ([type, key]) => (await listOf(token, type, String(records[key]))).statusCode,
        ),
      );

    // The Hyderabad branch manager.
    expect(
      await statuses(manager, [
        ['store', 'hyd'],
        ['purchase_order', 'hydOrder'],
        ['goods_receipt', 'receipt'],
        ['transfer', 'transfer'],
        ['party', 'supplier'],
        ['product', 'product'],
        ['store', 'pune'],
        ['purchase_order', 'puneOrder'],
        ['stock_count', 'puneCount'],
        ['party', 'puneCustomer'],
        ['lead', 'lead'],
        ['opportunity', 'opportunity'],
        ['project', 'project'],
        ['lead', 'puneLead'],
      ]),
    ).toEqual([200, 200, 200, 200, 200, 200, 404, 404, 404, 404, 200, 200, 200, 404]);
    // A store employee cannot see purchasing at all.
    expect(
      await statuses(cashier, [
        ['product', 'product'],
        ['purchase_order', 'hydOrder'],
      ]),
    ).toEqual([200, 403]);
    expect(
      (
        await api(cashier).get(
          `/documents?recordType=purchase_order&recordId=${String(records.hydOrder)}`,
        )
      ).json<{
        message: string;
      }>().message,
    ).toBe('You cannot see documents on this record');
  });

  it('downloads only for members who can see the record', async () => {
    const puneDocument = (await attach(owner, 'store', String(records.pune))).json<DocumentView>();

    expect((await api(manager).get(`/documents/${puneDocument.id}/download`)).statusCode).toBe(404);
    expect((await api(owner).get(`/documents/${puneDocument.id}/download`)).statusCode).toBe(200);
  });

  it('lets only members who can change the record add or remove its documents', async () => {
    const orderUpload = await attach(manager, 'purchase_order', String(records.hydOrder));
    const productUpload = await attach(cashier, 'product', String(records.product));
    const partyDocument = (
      await attach(manager, 'party', String(records.supplier))
    ).json<DocumentView>();

    const byCashier = await api(cashier).delete(`/documents/${partyDocument.id}`);
    const byManager = await api(manager).delete(`/documents/${partyDocument.id}`);
    const again = await api(manager).delete(`/documents/${partyDocument.id}`);

    expect([orderUpload.statusCode, orderUpload.json<{ message: string }>().message]).toEqual([
      403,
      'You cannot change documents on this record',
    ]);
    expect(productUpload.statusCode).toBe(403);
    expect(byCashier.statusCode).toBe(403);
    expect(byManager.statusCode).toBe(204);
    expect(again.statusCode).toBe(404);
    expect((await api(owner).get(`/documents/${partyDocument.id}/download`)).statusCode).toBe(404);
    const listed = (await listOf(owner, 'party', String(records.supplier))).json<DocumentView[]>();
    expect(listed.map((d) => d.id)).not.toContain(partyDocument.id);
  });

  it('answers 404 for records that do not exist', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';

    for (const type of [
      'party',
      'product',
      'store',
      'purchase_order',
      'goods_receipt',
      'transfer',
      'stock_count',
      'lead',
      'opportunity',
      'project',
      'contract',
    ]) {
      expect([type, (await listOf(owner, type, ghost)).statusCode]).toEqual([type, 404]);
    }
    expect((await attach(owner, 'party', ghost)).statusCode).toBe(404);
    expect((await api(owner).get(`/documents/${ghost}/download`)).statusCode).toBe(404);
  });
});

describe('refusals', () => {
  const party = () => String(records.supplier);
  const fields = () => ({ recordType: 'party', recordId: party(), category: 'contract' });

  it('refuses a file with a virus, and saves nothing', async () => {
    // Word files are ZIP archives; ClamAV looks inside them.
    const infected = zipArchive([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'word/eicar.com', data: EICAR },
    ]);
    const response = await attach(owner, 'party', party(), {
      fileName: 'contract.docx',
      data: infected,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ message: string }>().message).toMatch(
      /^This file contains a virus \(.*EICAR.*\) and was not saved$/i,
    );
    expect(response.json<{ code: string }>().code).toBe('virus_found');
    const listed = (await listOf(owner, 'party', party())).json<DocumentView[]>();
    expect(listed.map((d) => d.fileName)).not.toContain('contract.docx');
  });

  it.each([
    [
      { fileName: 'invoice.pdf', data: Buffer.from('<html><script>alert(1)</script></html>') },
      415,
      'file_type',
    ],
    [{ fileName: 'empty.pdf', data: Buffer.alloc(0) }, 400, 'empty_file'],
    [
      { fileName: 'huge.pdf', data: Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]) },
      413,
      'too_large',
    ],
  ])('refuses %#: wrong kind of file, empty or too large', async (file, status, code) => {
    const response = await upload(owner, fields(), [file]);

    // The app reads the code; people read the message.
    expect([response.statusCode, response.json<{ code: string }>().code]).toEqual([status, code]);
  });

  it('refuses uploads without exactly one file, or with bad fields', async () => {
    const none = await upload(owner, fields(), []);
    const two = await upload(owner, fields(), [
      { fileName: 'a.pdf', data: PDF },
      { fileName: 'b.pdf', data: PDF },
    ]);
    const bad = await upload(owner, { recordType: 'invoice', recordId: 'x' }, [
      { fileName: 'a.pdf', data: PDF },
    ]);
    const json = await api(owner).post('/documents', { recordType: 'party' });

    expect([none.statusCode, none.json<{ message: string }>().message]).toEqual([
      400,
      'Attach the file to upload',
    ]);
    expect(two.statusCode).toBe(400);
    expect(two.json<{ message: string }>().message).toMatch(/^The upload could not be read/);
    expect(
      bad
        .json<{ issues: { path: string }[] }>()
        .issues.map((issue) => issue.path)
        .sort(),
    ).toEqual(['category', 'recordId', 'recordType']);
    expect([json.statusCode, json.json<{ message: string }>().message]).toEqual([
      400,
      'Send the file as multipart/form-data',
    ]);
  });
});

describe('when storage or scanning is unavailable', () => {
  it('turns uploads and downloads off without storage, and refuses files it cannot scan', async () => {
    const withoutStorage = await startTestApp(database.connectionString);
    const env = await testBucket(
      inject('objectStorageEndpoint'),
      inject('virusScannerAddress'),
      'documents-no-scanner',
    );
    const withoutScanner = await startTestApp(database.connectionString, {
      ...env,
      CLAMAV_PORT: '1',
    });
    // Scanning works, but the files cannot be stored.
    const storageDown = await startTestApp(database.connectionString, {
      ...env,
      STORAGE_ENDPOINT: 'http://127.0.0.1:1',
    });
    try {
      const upload503 = await upload(
        owner,
        fields(),
        [{ fileName: 'a.pdf', data: PDF }],
        withoutStorage,
      );
      const download503 = await withoutStorage.app.inject({
        method: 'GET',
        url: '/documents/00000000-0000-4000-8000-000000000000/download',
        headers: bearer(owner),
      });
      const unscanned = await upload(
        owner,
        fields(),
        [{ fileName: 'a.pdf', data: PDF }],
        withoutScanner,
      );
      const unstored = await upload(
        owner,
        fields(),
        [{ fileName: 'a.pdf', data: PDF }],
        storageDown,
      );

      expect(upload503.json()).toEqual({
        statusCode: 503,
        message: 'Document storage is not set up on this server',
        code: 'storage_unavailable',
      });
      expect(download503.statusCode).toBe(503);
      expect(unscanned.statusCode).toBe(503);
      expect(unscanned.json<{ message: string }>().message).toMatch(
        /^Virus scanning is unavailable, so the file was not saved; try again shortly \(ClamAV is unavailable: /,
      );
      expect(unscanned.json<{ code: string }>().code).toBe('scanner_unavailable');
      expect(unstored.statusCode).toBe(503);
      expect(unstored.json<{ code: string; message: string }>()).toMatchObject({
        code: 'storage_unavailable',
        message: expect.stringMatching(
          /^Document storage is unavailable, so the file was not saved; try again shortly \(/,
        ),
      });
      const listed = (await listOf(owner, 'party', String(records.supplier))).json<
        DocumentView[]
      >();
      expect(listed.map((d) => d.fileName)).not.toContain('a.pdf');
    } finally {
      await withoutStorage.close();
      await withoutScanner.close();
      await storageDown.close();
    }
  });

  function fields() {
    return { recordType: 'party', recordId: String(records.supplier), category: 'other' };
  }
});
