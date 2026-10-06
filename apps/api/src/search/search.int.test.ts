import { migrateDatabase, schema } from '@paint/db';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import type { SearchHit, SearchResults } from './search.service.js';

let database: TestDatabase;
let t: TestApp;
let owner: string;
let sales: string;
let crm: string;
let cashier: string;
let hyd: string;
let pune: string;
let builderPhone: string;
const ids: Record<string, string> = {};

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object = {}) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
});
const idOf = async (response: ReturnType<ReturnType<typeof api>['post']>) =>
  (await response).json<{ id: string }>().id;
const search = async (token: string, q: string, limit?: number) =>
  (
    await api(token).get(
      `/search?q=${encodeURIComponent(q)}${limit ? `&limit=${String(limit)}` : ''}`,
    )
  ).json<SearchResults>();
const titles = (hits: SearchHit[] | null) => hits?.map((hit) => hit.title);

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

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  owner = await signup('ABC Paints');
  const o = api(owner);
  hyd = await idOf(o.post('/stores', { name: 'Hyderabad', code: 'HYD' }));
  pune = await idOf(o.post('/stores', { name: 'Pune', code: 'PUN' }));
  sales = await hire('sales_executive', [hyd]);
  crm = await hire('crm_executive', [hyd]);
  cashier = await hire('store_employee', [hyd]);
  builderPhone = uniquePhone();
  ids.builder = await idOf(
    o.post('/parties', {
      kind: 'organization',
      displayName: 'Sharma Builders',
      phone: builderPhone,
      roles: ['contractor', 'customer'],
    }),
  );
  ids.depot = await idOf(
    o.post('/parties', {
      kind: 'organization',
      displayName: 'Sharma Paints Depot',
      gstin: '36AABCU9603R1ZO',
      roles: ['supplier'],
    }),
  );
  await o.post('/parties', {
    displayName: 'Sharma Pune',
    phone: uniquePhone(),
    homeStoreId: pune,
    roles: ['customer'],
  });
  const retired = await idOf(
    o.post('/parties', { displayName: 'Sharma Retired', roles: ['customer'] }),
  );
  await t.app.inject({
    method: 'PATCH',
    url: `/parties/${retired}`,
    headers: bearer(owner),
    payload: { isActive: false },
  });
  const asian = await idOf(o.post('/brands', { name: 'Asian Paints' }));
  const berger = await idOf(o.post('/brands', { name: 'Berger' }));
  const apex = (
    await o.post('/products', {
      brandId: asian,
      name: 'Apex Ultima',
      type: 'exterior_paint',
      hsnCode: '3209',
      gstRatePercent: 18,
      variants: [
        { sku: 'APX-ULT-1L', packSize: 1, unit: 'l', barcodes: ['8901234567890'] },
        { sku: 'APX-ULT-20L', packSize: 20, unit: 'l' },
        { sku: 'APX-ULT-4L', packSize: 4, unit: 'l' },
      ],
    })
  ).json<{ id: string; variants: { id: string; sku: string }[] }>();
  ids.apex = apex.id;
  ids.apex1 = String(apex.variants.find((v) => v.sku === 'APX-ULT-1L')?.id);
  // A discontinued pack is not offered.
  await t.app.inject({
    method: 'PATCH',
    url: `/variants/${String(apex.variants.find((v) => v.sku === 'APX-ULT-4L')?.id)}`,
    headers: bearer(owner),
    payload: { isActive: false },
  });
  await o.post('/products', {
    brandId: berger,
    name: 'WeatherCoat',
    type: 'exterior_paint',
    hsnCode: '3209',
    gstRatePercent: 18,
    variants: [{ sku: 'WC-1L', packSize: 1, unit: 'l' }],
  });
  ids.lead = await idOf(
    o.post('/leads', {
      storeId: hyd,
      partyId: ids.builder,
      title: 'Kondapur tower',
      source: 'phone_call',
    }),
  );
  await o.post('/leads', {
    storeId: pune,
    partyId: ids.depot,
    title: 'Pune godown',
    source: 'walk_in',
  });
  await o.post('/opportunities', {
    storeId: hyd,
    partyId: ids.builder,
    title: 'Tower exterior',
    expectedValuePaise: 1,
  });
  ids.project = await idOf(
    o.post('/projects', {
      storeId: hyd,
      customerPartyId: ids.builder,
      name: 'Gachibowli Heights',
      city: 'Hyderabad',
    }),
  );
  await o.post('/stock/movements', {
    storeId: pune,
    type: 'opening',
    lines: [{ variantId: ids.apex1, quantity: 5 }],
  });
  ids.transfer = await idOf(
    o.post('/transfers', {
      fromStoreId: pune,
      toStoreId: hyd,
      lines: [{ variantId: ids.apex1, quantity: 1 }],
    }),
  );
  await o.post('/purchase-orders', {
    supplierId: ids.depot,
    storeId: hyd,
    lines: [{ variantId: ids.apex1, quantity: 1 }],
  });
  await o.post('/goods-receipts', {
    storeId: hyd,
    supplierId: ids.depot,
    supplierInvoiceNumber: 'AP/2026/77',
    lines: [{ variantId: ids.apex1, quantity: 1 }],
  });
  await o.post('/stock-counts', { storeId: pune });
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('search', () => {
  it('finds people, their leads, opportunities and projects by name, within the member’s stores', async () => {
    const results = await search(sales, 'sharma');

    expect(titles(results.parties)).toEqual(['Sharma Builders', 'Sharma Paints Depot']);
    expect(results.parties?.[0]).toMatchObject({
      subtitle: `${builderPhone} · contractor, customer`,
      path: `/parties/${String(ids.builder)}`,
    });
    expect(results.leads).toEqual([
      expect.objectContaining({
        title: expect.stringMatching(/^LD-\d{6} · Kondapur tower$/),
        subtitle: 'Sharma Builders · new',
        path: `/leads/${String(ids.lead)}`,
      }),
    ]);
    expect(titles(results.opportunities)).toEqual([
      expect.stringMatching(/^OP-\d{6} · Tower exterior$/),
    ]);
    expect(results.projects).toEqual([
      expect.objectContaining({
        subtitle: 'Sharma Builders · Hyderabad · identified',
        path: `/projects/${String(ids.project)}`,
      }),
    ]);
    expect(results.documents).toEqual([]);
  });

  it('finds a customer by part of their mobile number, and a supplier by GSTIN', async () => {
    const byPhone = await search(sales, builderPhone.slice(-6));
    const byGstin = await search(sales, '36aabcu');

    expect(titles(byPhone.parties)).toEqual(['Sharma Builders']);
    expect(titles(byGstin.parties)).toEqual(['Sharma Paints Depot']);
  });

  it('finds products by any words, exact SKU or barcode first', async () => {
    const words = await search(cashier, 'apex 20');
    const sku = await search(cashier, 'apx-ult-1l');
    const barcode = await search(cashier, '8901234567890');
    const brand = await search(cashier, 'berger');

    expect(titles(words.products)).toEqual(['Asian Paints Apex Ultima 20 l']);
    expect(sku.products?.[0]).toMatchObject({
      subtitle: 'APX-ULT-1L',
      path: `/products/${String(ids.apex)}`,
    });
    expect(titles(barcode.products)).toEqual(['Asian Paints Apex Ultima 1 l']);
    expect(brand.products?.map((hit) => hit.subtitle)).toEqual(['WC-1L']);
    // A discontinued pack is not offered.
    expect((await search(cashier, 'apx')).products?.map((hit) => hit.subtitle)).toEqual([
      'APX-ULT-1L',
      'APX-ULT-20L',
    ]);
  });

  it('finds documents by number or supplier invoice, as far as the member may see', async () => {
    const asOwner = await search(owner, '000001', 20);
    const asSales = await search(sales, '000001', 20);
    const asCrm = await search(crm, '000001');
    const byInvoice = await search(owner, 'AP/2026');

    expect(asOwner.documents.map((hit) => String(hit.subtitle).split(' ·')[0])).toEqual([
      'Transfer PUN → HYD',
      'Stock count PUN',
      'Purchase order',
      'Goods receipt',
    ]);
    expect(asOwner.documents[0]?.path).toBe(`/transfers/${String(ids.transfer)}`);
    // Sales can see stock but not purchasing, and not Pune's own stock count.
    expect(asSales.documents.map((hit) => hit.title)).toEqual([expect.stringMatching(/^TR-/)]);
    expect(asCrm.documents).toEqual([]);
    expect(byInvoice.documents).toEqual([
      expect.objectContaining({ subtitle: 'Goods receipt · Sharma Paints Depot · AP/2026/77' }),
    ]);
  });

  it('leaves out what the member cannot see, and offers only their quick actions', async () => {
    const results = await search(cashier, 'stock');

    expect(results).toMatchObject({ leads: null, opportunities: null, projects: null });
    expect(results.actions.map((action) => action.key)).toEqual(['low_stock']);
    expect((await search(owner, 'stock')).actions.map((action) => action.key)).toContain(
      'record_stock',
    );
  });

  it('shows nothing but quick actions to a role that may see no records', async () => {
    const [{ organizationId } = { organizationId: '' }] = await t.connection.db
      .select({ organizationId: schema.stores.organizationId })
      .from(schema.stores)
      .where(eq(schema.stores.id, hyd));
    const [role] = await t.connection.db
      .insert(schema.roles)
      .values({ organizationId, key: 'kiosk', name: 'Kiosk' })
      .returning({ id: schema.roles.id });
    await t.connection.db
      .insert(schema.rolePermissions)
      .values({ organizationId, roleId: String(role?.id), permission: 'stores:read' });
    const phone = uniquePhone();
    await api(owner).post('/members', {
      fullName: 'Kiosk',
      phone,
      password: 'Staff@2026',
      roleId: role?.id,
      storeIds: [hyd],
    });
    const kiosk = (
      await t.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { identifier: phone, password: 'Staff@2026' },
      })
    ).json<{ token: string }>().token;

    expect(await search(kiosk, 'follow')).toMatchObject({
      parties: null,
      products: null,
      leads: null,
      opportunities: null,
      projects: null,
      documents: [],
      actions: [expect.objectContaining({ key: 'my_follow_ups' })],
    });
  });

  it('treats % and _ as plain characters, not wildcards', async () => {
    const results = await search(owner, '%_');

    expect(results).toMatchObject({ parties: [], products: [], leads: [], projects: [] });
  });

  it('keeps limits, and needs at least two characters', async () => {
    expect(titles((await search(owner, 'sharma', 1)).parties)).toHaveLength(1);
    expect((await api(owner).get('/search?q=a')).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/search?q=ab' })).statusCode).toBe(401);
  });
});

describe('quick actions', () => {
  it('lists what the member may do, matching what they type', async () => {
    const all = (await api(owner).get('/search/actions')).json<
      { key: string; shortcut: string }[]
    >();
    const grnForOwner = (await api(owner).get('/search/actions?q=grn')).json<{ key: string }[]>();
    const grnForSales = (await api(sales).get('/search/actions?q=grn')).json<{ key: string }[]>();

    expect(all.length).toBeGreaterThan(10);
    expect(all[0]).toMatchObject({ key: 'new_customer', shortcut: 'N C' });
    expect(grnForOwner.map((action) => action.key)).toEqual(['receive_goods']);
    expect(grnForSales).toEqual([]);
    // + Contract for those who may create contracts, opening the contract form.
    expect((await api(crm).get('/search/actions?q=agreement')).json()).toEqual([
      expect.objectContaining({
        key: 'new_contract',
        label: '+ Contract',
        path: '/contracts/new',
        shortcut: 'N A',
      }),
    ]);
    expect((await api(sales).get('/search/actions?q=agreement')).json()).toEqual([]);
  });
});

describe('speed', () => {
  it('finds a customer or product among ten thousand of each in well under 2 seconds', async () => {
    const big = await signup('Big Paints');
    const [org] = await t.connection.db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.name, 'Big Paints'));
    const organizationId = String(org?.id);
    const brandId = await idOf(api(big).post('/brands', { name: 'Seed Brand' }));
    const productId = (
      await api(big).post('/products', {
        brandId,
        name: 'Seed Paint',
        type: 'interior_paint',
        hsnCode: '3209',
        gstRatePercent: 18,
        variants: [{ sku: 'SEED-0', packSize: 0.5, unit: 'l' }],
      })
    ).json<{ id: string }>().id;
    await withPgClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO parties (organization_id, display_name, phone)
         SELECT $1, 'Customer ' || g || ' ' || md5(g::text), '+9170' || lpad(g::text, 8, '0')
         FROM generate_series(1, 10000) g`,
        [organizationId],
      );
      await client.query(
        `INSERT INTO product_variants (organization_id, product_id, sku, pack_size, unit)
         SELECT $1, $2, 'SEED-' || g, g, 'l' FROM generate_series(1, 10000) g`,
        [organizationId, productId],
      );
      await client.query('ANALYZE parties; ANALYZE product_variants');
    });

    const timed = async (q: string) => {
      const start = performance.now();
      const results = await search(big, q);
      return { results, ms: performance.now() - start };
    };
    const customer = await timed('Customer 7777 ');
    const phone = await timed('00007777');
    const product = await timed('SEED-9876');

    expect(titles(customer.results.parties)?.[0]).toMatch(/^Customer 7777 /);
    expect(titles(phone.results.parties)).toEqual([expect.stringMatching(/^Customer 7777 /)]);
    expect(product.results.products?.[0]?.subtitle).toBe('SEED-9876');
    for (const { ms } of [customer, phone, product]) expect(ms).toBeLessThan(2_000);
  });
});
