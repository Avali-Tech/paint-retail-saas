import { findStockMismatches, migrateDatabase } from '@paint/db';
import { toCsv } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

interface Report {
  kind: string;
  committed: boolean;
  valid: boolean;
  totals: { rows: number; create: number; update: number; unchanged: number; errors: number };
  rows: { row: number; action: string; label: string }[];
  errors: { row: number; column: string | null; message: string }[];
}
interface Lookup {
  product: {
    id: string;
    name: string;
    type: string;
    hsnCode: string;
    gstRatePercent: number;
    taxCategory: { name: string } | null;
    description: string | null;
    brand: { name: string };
    category: { name: string } | null;
    variants: {
      sku: string;
      label: string | null;
      mrpPaise: number | null;
      sellingPricePaise: number | null;
      barcodes: string[];
    }[];
  };
  variant: {
    id: string;
    sku: string;
    mrpPaise: number | null;
    sellingPricePaise: number | null;
    barcodes: string[];
  };
}
interface Party {
  id: string;
  kind: string;
  displayName: string;
  phone: string | null;
  gstin: string | null;
  pan: string | null;
  city: string | null;
  homeStoreId: string | null;
  tags: string[];
  roles: string[];
  customer: { customerType: string } | null;
}
type Response = Awaited<ReturnType<ReturnType<typeof api>['post']>>;

let database: TestDatabase;
let t: TestApp;
let owner: string;
let manager: string;
let cashier: string;
let hyd: string;
let pune: string;
let seq = 0;

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object = {}) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  patch: (url: string, payload: object) =>
    t.app.inject({ method: 'PATCH', url, headers: bearer(token), payload }),
});

const preview = (kind: string, csv: string, token = owner) =>
  api(token).post(`/imports/${kind}/preview`, { csv });
const commit = (kind: string, csv: string, token = owner) =>
  api(token).post(`/imports/${kind}`, { csv });
const report = (response: Response) => response.json<Report>();
const failedReport = (response: Response) => response.json<{ message: string; report: Report }>();
const errorsOf = (response: Response) =>
  (response.statusCode === 400 ? failedReport(response).report : report(response)).errors.map(
    (e) => [e.row, e.column, e.message],
  );

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

const lookup = async (code: string) =>
  (await api(owner).get(`/products/lookup?code=${encodeURIComponent(code)}`)).json<Lookup>();

const PRODUCT_HEADER = [
  'brand',
  'product',
  'type',
  'hsn_code',
  'tax_category',
  'sku',
  'pack_size',
  'unit',
  'category',
  'description',
  'mrp',
  'selling_price',
  'barcodes',
];
/** A products file; each row lists cells in PRODUCT_HEADER order. */
const productsCsv = (...rows: string[][]) => toCsv([PRODUCT_HEADER, ...rows]);
let barcodeCounter = 0;
/** A valid EAN-13 barcode no other test uses. */
function ean(): string {
  barcodeCounter += 1;
  const digits = `890${String(barcodeCounter).padStart(9, '0')}`;
  const sum = Array.from(digits, Number).reduce((total, d, i) => total + d * (i % 2 ? 3 : 1), 0);
  return `${digits}${String((10 - (sum % 10)) % 10)}`;
}
const CODES = {
  apex1: ean(),
  tractor1: ean(),
  tractor2: ean(),
  apexNew: ean(),
  repeat: ean(),
  taken: ean(),
  taken2: ean(),
};
/** A unique brand and SKU prefix for a test. */
function names() {
  seq += 1;
  return { brand: `Imp Brand ${String(seq)}`, sku: `IMP${String(seq)}` };
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  owner = await signup('ABC Paints');
  hyd = (await api(owner).post('/stores', { name: 'Hyderabad', code: 'HYD' })).json<{
    id: string;
  }>().id;
  pune = (await api(owner).post('/stores', { name: 'Pune', code: 'PUN' })).json<{ id: string }>()
    .id;
  manager = await hire('branch_manager', [hyd]);
  cashier = await hire('store_employee', [hyd]);
});

afterAll(async () => {
  expect(await findStockMismatches(t.connection.db)).toEqual([]);
  await t.close();
  await database.stop();
});

describe('import kinds and templates', () => {
  it('lists each import with its columns and permission', async () => {
    const kinds = (await api(cashier).get('/imports')).json<
      { kind: string; permission: string; columns: { name: string; required: boolean }[] }[]
    >();

    expect(kinds.map((k) => [k.kind, k.permission])).toEqual([
      ['products', 'catalog:manage'],
      ['parties', 'parties:manage'],
      ['opening-stock', 'inventory:manage'],
      ['opening-balances', 'organization:manage'],
    ]);
    expect(kinds[0]?.columns.slice(0, 2)).toEqual([
      expect.objectContaining({ name: 'brand', required: true }),
      expect.objectContaining({ name: 'product', required: true }),
    ]);
  });

  it('downloads a template that Excel opens, whose example rows import cleanly', async () => {
    const files: Record<string, string> = {};
    for (const kind of ['products', 'parties', 'opening-stock']) {
      const response = await api(owner).get(`/imports/${kind}/template`);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="${kind}-template.csv"`,
      );
      expect(response.body.startsWith('﻿')).toBe(true);
      files[kind] = response.body;
    }

    // In order: the stock example uses the product example's SKU and store HYD.
    for (const kind of ['products', 'parties', 'opening-stock']) {
      const done = await commit(kind, String(files[kind]));
      expect([kind, done.statusCode, report(done).totals]).toEqual([
        kind,
        201,
        { rows: 1, create: 1, update: 0, unchanged: 0, errors: 0 },
      ]);
    }
  });

  it('answers 404 for an unknown import and 403 without the permission', async () => {
    expect((await api(owner).get('/imports/invoices/template')).statusCode).toBe(404);
    expect((await preview('invoices', 'a\n1')).statusCode).toBe(404);
    const denied = await preview('products', 'a\n1', manager);
    expect([denied.statusCode, denied.json<{ message: string }>().message]).toEqual([
      403,
      'You do not have permission to import this',
    ]);
    expect((await commit('opening-stock', 'a\n1', cashier)).statusCode).toBe(403);
    expect((await api(owner).post('/imports/products/preview', {})).statusCode).toBe(400);
  });
});

describe('reading the file', () => {
  it('reports a broken file as an error on its row, and refuses to commit it', async () => {
    const broken = 'brand,product\n"Asian,Apex\n';

    const checked = await preview('products', broken);
    const refused = await commit('products', broken);

    expect(checked.statusCode).toBe(200);
    expect(report(checked)).toEqual({
      kind: 'products',
      committed: false,
      valid: false,
      totals: { rows: 0, create: 0, update: 0, unchanged: 0, errors: 1 },
      rows: [],
      errors: [{ row: 2, column: null, message: 'A quoted value on row 2 is never closed' }],
    });
    expect(refused.statusCode).toBe(400);
    expect(failedReport(refused).message).toBe(
      'Nothing was imported: fix the rows with errors and try again',
    );
  });

  it('names unknown and missing columns', async () => {
    const response = await preview('opening-stock', 'store,sku,qty\nHYD,X,1\n');

    expect(errorsOf(response)).toEqual([
      [
        1,
        'qty',
        "Unknown column; use the template's columns: store, sku, variant_label, quantity, unit_cost",
      ],
      [1, 'quantity', 'This column is missing'],
    ]);
  });

  it('refuses a file without rows, and more than 5,000 rows', async () => {
    const empty = await preview('opening-stock', 'store,sku,quantity\n,,\n');
    // About 1.5 MB, over Fastify's default 1 MB body limit.
    const padding = 'X'.repeat(280);
    const huge = toCsv([
      ['store', 'sku', 'quantity'],
      ...Array.from({ length: 5_001 }, (_, i) => ['HYD', `${padding}${String(i)}`, '1']),
    ]);
    const tooMany = await preview('opening-stock', huge);

    expect(errorsOf(empty)).toEqual([[1, null, 'The file has no rows to import']]);
    expect(report(tooMany).totals.rows).toBe(5_001);
    expect(errorsOf(tooMany)).toEqual([[1, null, 'Import at most 5,000 rows at a time']]);
  });
});

describe('products', () => {
  it('previews without saving, then imports brands, categories, products, packs and barcodes', async () => {
    const { brand, sku } = names();
    const file = productsCsv(
      [
        brand,
        'Apex Ultima',
        'Exterior Paint',
        '3209',
        'Paints 18%',
        `${sku}-1L`,
        '1',
        'L',
        'Exterior emulsions',
        'Weatherproof',
        '650',
        '610.50',
        CODES.apex1,
      ],
      [
        brand,
        'Apex Ultima',
        'exterior_paint',
        '3209',
        'Paints 18%',
        `${sku}-4L`,
        '4',
        'l',
        '',
        '',
        '₹2,400',
        '',
        '',
      ],
      [
        brand,
        'Tractor Emulsion',
        'interior_paint',
        '320910',
        'Paints 18%',
        `${sku}-TR-10`,
        '10',
        'l',
        '',
        '',
        '',
        '',
        `${CODES.tractor1};${CODES.tractor2}`,
      ],
    );

    const checked = await preview('products', file);
    const before = await api(owner).get(`/products/lookup?code=${sku}-1L`);
    const saved = await commit('products', file);

    expect(report(checked)).toMatchObject({
      committed: false,
      valid: true,
      totals: { rows: 3, create: 3, update: 0, unchanged: 0, errors: 0 },
    });
    expect(report(checked).rows[0]).toEqual({
      row: 2,
      action: 'create',
      label: `${sku}-1L · ${brand} Apex Ultima 1 l`,
    });
    expect(before.statusCode).toBe(404);
    expect(saved.statusCode).toBe(201);
    expect(report(saved).committed).toBe(true);
    const apex = await lookup(CODES.apex1);
    expect(apex.product).toMatchObject({
      name: 'Apex Ultima',
      type: 'exterior_paint',
      hsnCode: '3209',
      description: 'Weatherproof',
      brand: { name: brand },
      category: { name: 'Exterior emulsions' },
    });
    expect(apex.product.variants.map((v) => [v.sku, v.mrpPaise, v.sellingPricePaise])).toEqual([
      [`${sku}-1L`, 65_000, 61_050],
      [`${sku}-4L`, 240_000, null],
    ]);
    expect((await lookup(CODES.tractor2)).variant.barcodes.sort()).toEqual([
      CODES.tractor1,
      CODES.tractor2,
    ]);
  });

  it('matches by SKU when run again: unchanged rows stay, changed ones update', async () => {
    const { brand, sku } = names();
    const file = (
      price: string,
      { hsn = '3209', type = 'exterior_paint', description = 'Tough', codes = '' } = {},
    ) =>
      productsCsv(
        [
          brand,
          'Apex',
          type,
          hsn,
          'Paints 18%',
          `${sku}-1L`,
          '1',
          'l',
          'Exteriors',
          description,
          '650',
          price,
          codes,
        ],
        [brand, 'Apex', type, hsn, 'Paints 18%', `${sku}-4L`, '4', 'l', '', '', '', '', ''],
      );
    await commit('products', file('600'));

    const again = report(await commit('products', file('600')));
    const changed = report(
      await commit('products', file('620', { hsn: '32091090', codes: CODES.apexNew })),
    );
    const sameBarcode = report(
      await commit('products', file('620', { hsn: '32091090', codes: CODES.apexNew })),
    );
    const retyped = report(
      await commit(
        'products',
        file('620', { hsn: '32091090', type: 'primer', description: 'Primer' }),
      ),
    );

    expect(again).toMatchObject({
      committed: true,
      totals: { create: 0, update: 0, unchanged: 2 },
    });
    // The HSN belongs to the product, so both of its packs change.
    expect(changed.totals).toMatchObject({ create: 0, update: 2, unchanged: 0 });
    expect(sameBarcode.totals).toMatchObject({ update: 0, unchanged: 2 });
    expect(retyped.totals).toMatchObject({ update: 2 });
    const { product, variant } = await lookup(`${sku}-1L`);
    expect(product).toMatchObject({ hsnCode: '32091090', type: 'primer', description: 'Primer' });
    expect(product.variants).toHaveLength(2);
    expect(variant).toMatchObject({ sellingPricePaise: 62_000, barcodes: [CODES.apexNew] });
  });

  it('reuses brands and categories whatever their case, and keeps details left blank', async () => {
    const { brand, sku } = names();
    await commit(
      'products',
      productsCsv([
        brand,
        'Royale',
        'interior_paint',
        '3209',
        'Paints 18%',
        `${sku}-1L`,
        '1',
        'l',
        'Luxury Emulsions',
        'Soft sheen',
        '900',
        '',
        '',
      ]),
    );

    const saved = await commit(
      'products',
      productsCsv(
        [
          brand.toUpperCase(),
          'ROYALE',
          'interior_paint',
          '3209',
          'Paints 18%',
          `${sku}-1L`,
          '1',
          'l',
          '',
          '',
          '',
          '',
          '',
        ],
        [
          brand.toLowerCase(),
          'Royale Shyne',
          'interior_paint',
          '3209',
          'Paints 18%',
          `${sku}-SH-1L`,
          '1',
          'l',
          'luxury emulsions',
          '',
          '',
          '',
          '',
        ],
      ),
    );

    expect(report(saved).totals).toMatchObject({ create: 1, update: 0, unchanged: 1 });
    const royale = await lookup(`${sku}-1L`);
    expect(royale.product).toMatchObject({
      name: 'Royale',
      description: 'Soft sheen',
      category: { name: 'Luxury Emulsions' },
    });
    expect(royale.variant.mrpPaise).toBe(90_000);
    const shyne = await lookup(`${sku}-SH-1L`);
    expect(shyne.product.brand.name).toBe(brand);
    expect(shyne.product.category?.name).toBe('Luxury Emulsions');
  });

  it('checks each cell', async () => {
    const { brand, sku } = names();
    const response = await preview(
      'products',
      productsCsv(
        [
          '',
          'Apex',
          'emulsion',
          '32',
          'Luxury 99%',
          'a',
          '0',
          'litre',
          '',
          '',
          '6.505',
          '1,0,0.x',
          '123',
        ],
        [brand, 'Apex', 'primer', '3209', 'P', `${sku}-2`, '1.0005', 'kg', 'X', '', '-5', '', ''],
      ),
    );

    expect(report(response).valid).toBe(false);
    expect(errorsOf(response)).toEqual([
      [2, 'barcodes', 'Barcode is not valid (check digit or characters)'],
      [2, 'brand', 'Required'],
      [2, 'hsn_code', 'Enter a 4, 6 or 8-digit HSN code'],
      [2, 'mrp', 'Enter an amount in rupees, such as 1250.50'],
      [2, 'pack_size', 'Too small: expected number to be >0'],
      [2, 'selling_price', 'Enter an amount in rupees, such as 1250.50'],
      [2, 'sku', 'Use 2 to 40 letters, digits or . _ / -'],
      [
        2,
        'type',
        `Use one of: interior_paint, exterior_paint, primer, putty, enamel, wood_finish, waterproofing, texture, thinner, tool, other, colorant`,
      ],
      [2, 'unit', 'Use one of: ml, l, g, kg, piece, set, m'],
      [3, 'category', 'Too small: expected string to have >=2 characters'],
      [3, 'mrp', 'Cannot be negative'],
      [3, 'pack_size', 'Use at most 3 decimals'],
      [3, 'tax_category', 'Too small: expected string to have >=2 characters'],
    ]);
  });

  it('finds repeats and contradictions within the file', async () => {
    const { brand, sku } = names();
    const base = (overrides: Record<number, string>) => {
      const cells = [
        brand,
        'Apex',
        'exterior_paint',
        '3209',
        'Paints 18%',
        `${sku}-1L`,
        '1',
        'l',
        'Ext',
        'Good',
        '',
        '',
        '',
      ];
      for (const [index, value] of Object.entries(overrides)) cells[Number(index)] = value;
      return cells;
    };

    const response = await commit(
      'products',
      productsCsv(
        base({ 12: CODES.repeat }),
        base({}),
        base({
          5: `${sku}-4L`,
          6: '4',
          2: 'primer',
          3: '3208',
          4: 'Exempt',
          8: 'Other',
          9: 'Other text',
          12: CODES.repeat,
        }),
        base({ 5: `${sku}-1L-B` }),
        base({ 5: `${sku}-500`, 6: '500', 7: 'ml', 10: '100', 11: '120' }),
      ),
    );

    expect(response.statusCode).toBe(400);
    expect(errorsOf(response)).toEqual([
      [3, 'pack_size', 'Same pack size and label as row 2'],
      [3, 'sku', 'Also on row 2'],
      [4, 'barcodes', `${CODES.repeat} is also on row 2`],
      [4, 'category', 'Differs from row 2 for the same product'],
      [4, 'description', 'Differs from row 2 for the same product'],
      [4, 'hsn_code', 'Differs from row 2 for the same product'],
      [4, 'tax_category', 'Differs from row 2 for the same product'],
      [4, 'type', 'Differs from row 2 for the same product'],
      [5, 'pack_size', 'Same pack size and label as row 2'],
      [6, 'selling_price', 'Selling price cannot exceed the MRP'],
    ]);
    expect((await api(owner).get(`/products/lookup?code=${sku}-1L`)).statusCode).toBe(404);
  });

  it('refuses SKUs, packs and barcodes already used by other products', async () => {
    const { brand, sku } = names();
    const pack = (product: string, code: string, size: string, price = '', barcodes = '') => [
      brand,
      product,
      'exterior_paint',
      '3209',
      'Paints 18%',
      code,
      size,
      'l',
      '',
      '',
      '',
      price,
      barcodes,
    ];
    const apex = pack('Apex', `${sku}-1L`, '1', '', `${CODES.taken};${CODES.taken2}`);
    apex[10] = '650';
    await commit('products', productsCsv(apex, pack('Ace', `${sku}-ACE-1L`, '1')));

    const response = await preview(
      'products',
      productsCsv(
        pack('Ace', `${sku}-1L`, '4'),
        pack('Apex', `${sku}-1L-NEW`, '1'),
        pack('Ace', `${sku}-ACE-1L`, '1', '', CODES.taken),
        pack('Ace', `${sku}-ACE-5L`, '5', '', CODES.taken2),
        pack('Apex', `${sku}-20L`, '20', '700'),
      ),
    );
    const priced = await preview('products', productsCsv(pack('Apex', `${sku}-1L`, '1', '700')));

    expect(errorsOf(response)).toEqual([
      [2, 'sku', `${sku}-1L already belongs to ${brand} Apex`],
      [3, 'pack_size', `Apex already has a 1 l pack (SKU ${sku}-1L)`],
      [4, 'barcodes', `${CODES.taken} is already on another product`],
      [5, 'barcodes', `${CODES.taken2} is already on another product`],
    ]);
    // A new pack with a price but no MRP is fine.
    expect(report(response).rows).toEqual([expect.objectContaining({ row: 6, action: 'create' })]);
    // The existing MRP (₹650) still applies when only the price is given.
    expect(errorsOf(priced)).toEqual([[2, 'selling_price', 'Selling price cannot exceed the MRP']]);
  });

  it('adds no products to an inactive brand or category, but still updates existing ones', async () => {
    const { brand, sku } = names();
    const kept = `Imp Kept ${sku}`;
    const retired = `Imp Retired ${sku}`;
    const row = (product: string, code: string, category: string, price = '') => [
      brand,
      product,
      'exterior_paint',
      '3209',
      'Paints 18%',
      code,
      '1',
      'l',
      category,
      '',
      '',
      price,
      '',
    ];
    await commit('products', productsCsv(row('Apex', `${sku}-1L`, kept)));
    await api(owner).post('/categories', { name: retired });
    const brands = (await api(owner).get('/brands')).json<{ id: string; name: string }[]>();
    const categories = (await api(owner).get('/categories')).json<{ id: string; name: string }[]>();
    const idOf = (list: { id: string; name: string }[], name: string) =>
      String(list.find((item) => item.name === name)?.id);
    await api(owner).patch(`/brands/${idOf(brands, brand)}`, { isActive: false });
    await api(owner).patch(`/categories/${idOf(categories, kept)}`, { isActive: false });
    await api(owner).patch(`/categories/${idOf(categories, retired)}`, { isActive: false });

    const newProduct = await preview('products', productsCsv(row('Ace', `${sku}-ACE`, '')));
    const moved = await preview('products', productsCsv(row('Apex', `${sku}-1L`, retired)));
    const repriced = await preview('products', productsCsv(row('Apex', `${sku}-1L`, kept, '500')));

    expect(errorsOf(newProduct)).toEqual([
      [2, 'brand', `${brand} is inactive. Reactivate it first.`],
    ]);
    expect(errorsOf(moved)).toEqual([
      [2, 'category', `${retired} is inactive. Reactivate it first.`],
    ]);
    expect(errorsOf(repriced)).toEqual([]);
    expect(report(repriced).rows).toEqual([expect.objectContaining({ row: 2, action: 'update' })]);
  });
});

describe('labelled pieces', () => {
  /** A hardware row: one piece of `size` told apart by `label` (the last column). */
  const piece = (
    brand: string,
    code: string,
    label: string,
    extra: Record<number, string> = {},
  ) => {
    const cells = [
      brand,
      'Paint Brush',
      'tool',
      '9603',
      'Brushes & rollers 18%',
      code,
      '1',
      'piece',
      '',
      '',
      '',
      '',
      '',
      label,
    ];
    for (const [index, value] of Object.entries(extra)) cells[Number(index)] = value;
    return cells;
  };
  const labelledCsv = (...rows: string[][]) =>
    toCsv([[...PRODUCT_HEADER, 'variant_label'], ...rows]);

  it('imports one product with a piece per label, and matches the labels next time', async () => {
    const { brand, sku } = names();
    const file = labelledCsv(
      piece(brand, `${sku}-1I`, '1 inch'),
      piece(brand, `${sku}-2I`, '2 inch'),
      piece(brand, `${sku}-3I`, '3 inch', { 6: '6' }),
    );

    const saved = report(await commit('products', file));
    const again = report(await commit('products', file));
    const renamed = report(
      await commit(
        'products',
        labelledCsv(
          piece(brand, `${sku}-1I`, '1 inch flat'),
          piece(brand, `${sku}-2I`, ''),
          piece(brand, `${sku}-3I`, '3 inch', { 6: '6' }),
        ),
      ),
    );

    expect(saved.rows.map((row) => row.label)).toEqual([
      `${sku}-1I · ${brand} Paint Brush 1 inch`,
      `${sku}-2I · ${brand} Paint Brush 2 inch`,
      `${sku}-3I · ${brand} Paint Brush 3 inch · 6 piece`,
    ]);
    expect(again.totals).toMatchObject({ create: 0, update: 0, unchanged: 3 });
    // A new label updates the piece; a blank one keeps the saved label.
    expect(renamed.rows.map((row) => row.action)).toEqual(['update', 'unchanged', 'unchanged']);
    const { product } = await lookup(`${sku}-2I`);
    expect(product.variants.map((variant) => [variant.sku, variant.label])).toEqual([
      [`${sku}-1I`, '1 inch flat'],
      [`${sku}-2I`, '2 inch'],
      [`${sku}-3I`, '3 inch'],
    ]);
  });

  it('refuses the same size and label twice, in the file or against saved pieces', async () => {
    const { brand, sku } = names();
    await commit('products', labelledCsv(piece(brand, `${sku}-2I`, '2 inch')));

    const response = await preview(
      'products',
      labelledCsv(
        piece(brand, `${sku}-4I`, '4 inch'),
        piece(brand, `${sku}-4I-B`, '4 INCH'),
        piece(brand, `${sku}-2I-B`, '2 Inch'),
        piece(brand, `${sku}-X`, 'x'.repeat(41)),
      ),
    );

    expect(errorsOf(response)).toEqual([
      [3, 'pack_size', 'Same pack size and label as row 2'],
      [4, 'pack_size', `Paint Brush already has a 2 Inch pack (SKU ${sku}-2I)`],
      [5, 'variant_label', 'Use at most 40 characters'],
    ]);
  });

  it('checks an opening-stock row’s label against its SKU', async () => {
    const { brand, sku } = names();
    await commit(
      'products',
      labelledCsv(piece(brand, `${sku}-1I`, '1 inch'), piece(brand, `${sku}-2I`, '2 inch')),
    );
    const stockCsv = (...rows: string[][]) =>
      toCsv([['store', 'sku', 'variant_label', 'quantity'], ...rows]);

    const wrong = await preview(
      'opening-stock',
      stockCsv(['HYD', `${sku}-1I`, '2 inch', '5'], ['HYD', `${sku}-2I`, '2 INCH', '7']),
    );

    expect(errorsOf(wrong)).toEqual([[2, 'variant_label', `Does not match ${sku}-1I (1 inch)`]]);
    expect(report(wrong).rows).toEqual([
      { row: 3, action: 'create', label: `HYD · ${sku}-2I · 2 inch` },
    ]);
  });
});

describe('parties', () => {
  const HEADER = [
    'name',
    'roles',
    'kind',
    'phone',
    'gstin',
    'pan',
    'city',
    'home_store',
    'customer_type',
    'tags',
  ];
  const partiesCsv = (...rows: string[][]) => toCsv([HEADER, ...rows]);
  const party = async (id: string) => (await api(owner).get(`/parties/${id}`)).json<Party>();
  const findByPhone = async (phone: string) =>
    (await api(owner).get(`/parties?q=${encodeURIComponent(phone)}`)).json<{ items: Party[] }>()
      .items[0];

  it('adds customers, suppliers and painters, with the PAN taken from the GSTIN', async () => {
    const painterPhone = uniquePhone();
    const contractorPhone = uniquePhone();
    const file = partiesCsv(
      [
        'Ramesh Painter',
        'painter',
        '',
        painterPhone.slice(3),
        '',
        '',
        'Hyderabad',
        'hyd',
        '',
        'Best; best',
      ],
      [
        'Sharma Constructions',
        'customer;Contractor',
        'Organization',
        contractorPhone,
        '',
        'ABCDE1234F',
        '',
        '',
        'builder',
        '',
      ],
      ['Berger Depot', 'supplier', 'organization', '', '27AAPFU0939F1ZV', '', 'Pune', '', '', ''],
    );

    const saved = await commit('parties', file, manager);

    expect(saved.statusCode).toBe(201);
    expect(report(saved).totals).toMatchObject({ create: 3 });
    const painter = await findByPhone(painterPhone);
    expect(painter).toMatchObject({
      displayName: 'Ramesh Painter',
      kind: 'person',
      phone: painterPhone,
      homeStoreId: hyd,
      tags: ['best'],
      roles: ['painter'],
      customer: null,
    });
    const contractor = await findByPhone(contractorPhone);
    expect(contractor).toMatchObject({
      kind: 'organization',
      pan: 'ABCDE1234F',
      roles: expect.arrayContaining(['customer', 'contractor']),
      customer: { customerType: 'builder' },
    });
    const suppliers = (await api(owner).get('/suppliers?q=Berger Depot')).json<{
      items: { id: string }[];
    }>();
    expect(await party(String(suppliers.items[0]?.id))).toMatchObject({
      gstin: '27AAPFU0939F1ZV',
      pan: 'AAPFU0939F',
      roles: ['supplier'],
    });

    const again = report(await commit('parties', file, manager));
    expect(again.totals).toMatchObject({ create: 0, update: 0, unchanged: 3 });
  });

  it('updates the party matched by GSTIN or phone, keeping what blank cells leave out', async () => {
    const phone = uniquePhone();
    const gstinParty = (
      await api(owner).post('/parties', {
        kind: 'organization',
        displayName: 'Nerolac Agency',
        gstin: '24AAACR5055K1ZD',
        city: 'Warangal',
        tags: ['old'],
        roles: ['supplier'],
      })
    ).json<Party>();
    const customer = (
      await api(owner).post('/parties', { displayName: 'Anil Kumar', phone, roles: ['customer'] })
    ).json<Party>();

    const response = await commit(
      'parties',
      partiesCsv(
        [
          'Nerolac Agency',
          'supplier;customer',
          '',
          '',
          '24AAACR5055K1ZD',
          '',
          'Hyderabad',
          '',
          '',
          'new',
        ],
        ['Anil Kumar', 'customer', '', phone, '', '', '', '', 'painter', ''],
      ),
    );

    expect(report(response).rows.map((r) => r.action)).toEqual(['update', 'update']);
    expect(await party(gstinParty.id)).toMatchObject({
      city: 'Hyderabad',
      tags: ['old', 'new'],
      roles: expect.arrayContaining(['supplier', 'customer']),
      customer: { customerType: 'retail' },
    });
    expect(await party(customer.id)).toMatchObject({
      displayName: 'Anil Kumar',
      customer: { customerType: 'painter' },
    });
  });

  it('checks each row', async () => {
    const taken = uniquePhone();
    const other = (
      await api(owner).post('/parties', {
        displayName: 'Phone Owner',
        phone: taken,
        roles: ['customer'],
      })
    ).json<Party>();
    await api(owner).post('/parties', {
      kind: 'organization',
      displayName: 'GSTIN Owner',
      gstin: '29AAGCB7383J1Z4',
      roles: ['supplier'],
    });
    const punePhone = uniquePhone();
    await api(owner).post('/parties', {
      displayName: 'Pune Customer',
      phone: punePhone,
      homeStoreId: pune,
      roles: ['customer'],
    });
    const repeated = uniquePhone();

    const response = await preview(
      'parties',
      partiesCsv(
        ['No Contact', 'customer', '', '', '', '', '', '', '', ''],
        ['Wrong Type', 'supplier', '', uniquePhone(), '', '', '', '', 'retail', ''],
        ['Twice', 'painter', '', repeated, '', '', '', '', '', ''],
        ['Twice Again', 'painter', '', repeated, '', '', '', '', '', ''],
        ['Mixed', 'customer', '', taken, '29AAGCB7383J1Z4', '', '', '', '', ''],
        ['Nowhere', 'customer', '', uniquePhone(), '', '', '', 'XYZ', '', ''],
        ['Elsewhere', 'customer', '', uniquePhone(), '', '', '', 'PUN', '', ''],
        ['Hidden', 'customer', '', punePhone, '', '', '', '', '', ''],
        ['Bad PAN', 'supplier', '', '', '27AAPFU0939F1ZV', 'ABCDE1234F', '', '', '', ''],
        ['X', 'buyer', 'company', '123', 'NOTAGSTIN', '', '', '', '', ''],
      ),
      manager,
    );

    expect(errorsOf(response)).toEqual([
      [2, 'phone', 'Enter a mobile number or a GSTIN, so the row matches the same party next time'],
      [3, 'customer_type', 'Only for parties with the customer role'],
      [5, 'phone', 'Also on row 4'],
      [6, 'phone', `This number is ${other.displayName}'s, but the GSTIN is GSTIN Owner's`],
      [7, 'home_store', 'Unknown store code'],
      [8, 'home_store', 'You cannot add parties to a store you cannot access'],
      [9, 'name', 'Matches a party at a store you cannot access'],
      [10, 'pan', 'The PAN does not match the GSTIN'],
      [11, 'gstin', 'Enter a valid GSTIN (check for typos)'],
      [11, 'kind', 'Use one of: person, organization'],
      [11, 'name', 'Use at least 2 characters'],
      [11, 'phone', 'Enter a valid mobile number'],
      [11, 'roles', expect.stringContaining('Use one of: customer')],
    ]);
  });

  it('refuses a GSTIN repeated in the file', async () => {
    const response = await preview(
      'parties',
      partiesCsv(
        ['Depot One', 'supplier', '', '', '19AAACI1681G1ZM', '', '', '', '', ''],
        ['Depot Two', 'supplier', '', '', '19AAACI1681G1ZM', '', '', '', '', ''],
      ),
    );

    expect(errorsOf(response)).toEqual([[3, 'gstin', 'Also on row 2']]);
  });

  it('runs one import at a time, so two at once do not add the same party twice', async () => {
    const file = partiesCsv([
      'Simultaneous',
      'customer',
      '',
      uniquePhone(),
      '',
      '',
      '',
      '',
      '',
      '',
    ]);

    const results = await Promise.all([commit('parties', file), commit('parties', file)]);

    expect(results.map((r) => r.statusCode)).toEqual([201, 201]);
    expect(results.map((r) => report(r).rows[0]?.action).sort()).toEqual(['create', 'unchanged']);
  });
});

describe('opening stock', () => {
  const stockCsv = (...rows: string[][]) =>
    toCsv([['store', 'sku', 'quantity', 'unit_cost'], ...rows]);
  const stockAt = async (variantId: string) =>
    (await api(owner).get(`/stock?storeId=${hyd}&limit=200`))
      .json<{ items: { variant: { id: string }; onHand: number; avgCostPaise: number | null }[] }>()
      .items.find((row) => row.variant.id === variantId);

  async function products() {
    const { brand, sku } = names();
    await commit(
      'products',
      productsCsv(
        [
          brand,
          'Stock Paint',
          'interior_paint',
          '3209',
          'Paints 18%',
          `${sku}-1L`,
          '1',
          'l',
          '',
          '',
          '',
          '',
          '',
        ],
        [
          brand,
          'Stock Paint',
          'interior_paint',
          '3209',
          'Paints 18%',
          `${sku}-4L`,
          '4',
          'l',
          '',
          '',
          '',
          '',
          '',
        ],
      ),
    );
    return {
      one: `${sku}-1L`,
      four: `${sku}-4L`,
      oneId: (await lookup(`${sku}-1L`)).variant.id,
      fourId: (await lookup(`${sku}-4L`)).variant.id,
    };
  }

  it('posts opening stock once; running the same file again changes nothing', async () => {
    const { one, four, oneId, fourId } = await products();
    const file = stockCsv(['hyd', one.toLowerCase(), '24', '520.00'], ['HYD', four, '2.5', '']);

    const saved = await commit('opening-stock', file, manager);
    const again = await commit('opening-stock', file, manager);

    expect(report(saved).totals).toMatchObject({ create: 2 });
    expect(report(saved).rows[0]?.label).toBe(`HYD · ${one} · 1 l`);
    expect(report(again).totals).toMatchObject({ create: 0, unchanged: 2 });
    expect(await stockAt(oneId)).toMatchObject({ onHand: 24, avgCostPaise: 52_000 });
    expect(await stockAt(fourId)).toMatchObject({ onHand: 2.5, avgCostPaise: null });
  });

  it('will not overwrite stock that has moved or differs; that is what stock counts are for', async () => {
    const { one, four, fourId } = await products();
    await commit('opening-stock', stockCsv(['HYD', one, '10', ''], ['HYD', four, '5', '']));
    await api(owner).post('/stock/movements', {
      storeId: hyd,
      type: 'damage',
      note: 'Dented tin',
      lines: [{ variantId: fourId, quantity: 1 }],
    });

    const response = await commit(
      'opening-stock',
      stockCsv(['HYD', one, '12', ''], ['HYD', four, '5', '']),
    );

    expect(errorsOf(response)).toEqual([
      [
        2,
        'quantity',
        `HYD already has stock movements for ${one} (10 on the books); correct it with a stock count`,
      ],
      [
        3,
        'quantity',
        `HYD already has stock movements for ${four} (4 on the books); correct it with a stock count`,
      ],
    ]);
  });

  it('checks stores, SKUs, quantities and costs', async () => {
    const { one } = await products();

    const response = await preview(
      'opening-stock',
      stockCsv(
        ['HYD', one, '1', ''],
        ['HYD', one, '2', ''],
        ['XYZ', one, '1', ''],
        ['PUN', one, '1', ''],
        ['HYD', 'NO-SUCH-SKU', '1', ''],
        ['HYD', 'B', '0', 'abc'],
        ['', '', '1.0001', ''],
      ),
      manager,
    );

    expect(errorsOf(response)).toEqual([
      [3, 'sku', 'Also on row 2 for this store'],
      [4, 'store', 'Unknown store code, or a store you cannot access'],
      [5, 'store', 'Unknown store code, or a store you cannot access'],
      [6, 'sku', 'Unknown SKU; import products first'],
      [7, 'quantity', 'Must be more than zero'],
      [7, 'unit_cost', 'Enter an amount in rupees, such as 1250.50'],
      [8, 'quantity', 'Use at most 3 decimals'],
      [8, 'sku', 'Required'],
      [8, 'store', 'Required'],
    ]);
    expect(report(response).rows).toEqual([
      { row: 2, action: 'create', label: `HYD · ${one} · 1 l` },
    ]);
  });
});
