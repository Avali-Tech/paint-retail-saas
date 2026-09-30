import { migrateDatabase } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

interface Variant {
  id: string;
  sku: string;
  packSize: number;
  unit: string;
  mrpPaise: number | null;
  sellingPricePaise: number | null;
  isActive: boolean;
  barcodes: string[];
}
interface Product {
  id: string;
  name: string;
  type: string;
  hsnCode: string;
  gstRatePercent: number;
  isActive: boolean;
  description: string | null;
  brand: { id: string; name: string };
  category: { id: string; name: string; parentId: string | null } | null;
  variants: Variant[];
}
interface Page {
  items: Product[];
  total: number;
}

let database: TestDatabase;
let t: TestApp;
let owner: string;
let inventoryManager: string;
let storeEmployee: string;

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  patch: (url: string, payload: object) =>
    t.app.inject({ method: 'PATCH', url, headers: bearer(token), payload }),
});

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

async function hire(roleKey: string): Promise<string> {
  const roles = (await api(owner).get('/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  await api(owner).post('/members', {
    fullName: roleKey,
    phone,
    password: 'Staff@2026',
    roleId: roles.find((role) => role.key === roleKey)?.id,
    allStores: false,
  });
  const login = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier: phone, password: 'Staff@2026' },
  });
  return login.json<{ token: string }>().token;
}

let seq = 0;
const next = () => (seq += 1);

async function brand(name = `Brand ${String(next())}`, token = owner): Promise<string> {
  const response = await api(token).post('/brands', { name });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

async function category(name: string, parentId?: string): Promise<string> {
  const response = await api(owner).post('/categories', { name, parentId });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

async function product(overrides: object = {}, token = owner): Promise<Product> {
  const n = next();
  const response = await api(token).post('/products', {
    brandId: await brand(),
    name: `Product ${String(n)}`,
    type: 'interior_paint',
    hsnCode: '3209',
    gstRatePercent: 18,
    variants: [{ sku: `SKU-${String(n)}-1L`, packSize: 1, unit: 'l' }],
    ...overrides,
  });
  expect(response.statusCode).toBe(201);
  return response.json<Product>();
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  owner = await signup('ABC Paints');
  inventoryManager = await hire('inventory_manager');
  storeEmployee = await hire('store_employee');
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('brands', () => {
  it('creates, lists ignoring case, renames and deactivates', async () => {
    const zeta = await brand('zeta Paints');
    await brand('Alpha Coatings');

    const renamed = await api(owner).patch(`/brands/${zeta}`, {
      name: 'Zeta Paints',
      isActive: false,
    });
    const names = (await api(owner).get('/brands')).json<{ name: string }[]>().map((b) => b.name);

    expect(renamed.json()).toEqual({ id: zeta, name: 'Zeta Paints', isActive: false });
    expect(names.indexOf('Alpha Coatings')).toBeLessThan(names.indexOf('Zeta Paints'));
  });

  it('refuses a name that differs only in case', async () => {
    await brand('Asian Paints');

    const response = await api(owner).post('/brands', { name: 'ASIAN PAINTS' });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toBe(
      'A brand with this name already exists',
    );
  });

  it('answers 404 for an unknown brand and 400 for bad input', async () => {
    expect(
      (await api(owner).patch('/brands/00000000-0000-4000-8000-000000000000', { name: 'Nope' }))
        .statusCode,
    ).toBe(404);
    expect((await api(owner).post('/brands', { name: 'A' })).statusCode).toBe(400);
    expect((await api(owner).patch(`/brands/${await brand()}`, {})).statusCode).toBe(400);
  });

  it('lets inventory managers manage brands and store staff only read them', async () => {
    expect((await api(inventoryManager).post('/brands', { name: 'Berger' })).statusCode).toBe(201);
    expect((await api(storeEmployee).get('/brands')).statusCode).toBe(200);
    expect((await api(storeEmployee).post('/brands', { name: 'Nerolac' })).statusCode).toBe(403);
  });
});

describe('categories', () => {
  it('supports categories with subcategories, two levels deep', async () => {
    const interior = await category('Interior');
    const emulsions = await category('Emulsions', interior);

    const tooDeep = await api(owner).post('/categories', { name: 'Luxury', parentId: emulsions });
    const list = (await api(owner).get('/categories')).json<
      { id: string; parentId: string | null }[]
    >();

    expect(tooDeep.statusCode).toBe(400);
    expect(list.find((c) => c.id === emulsions)?.parentId).toBe(interior);
  });

  it('allows the same name under different parents but not twice at one level', async () => {
    const walls = await category('Walls');
    const metal = await category('Metal');
    await category('Primers', walls);
    await category('Primers', metal);

    expect(
      (await api(owner).post('/categories', { name: 'primers', parentId: walls })).statusCode,
    ).toBe(409);
    expect((await api(owner).post('/categories', { name: 'WALLS' })).statusCode).toBe(409);
  });

  it('renames, and answers 400 for an unknown parent and 404 for an unknown category', async () => {
    const wood = await category('Wood');

    expect(
      (await api(owner).patch(`/categories/${wood}`, { name: 'Wood Finishes' })).json(),
    ).toMatchObject({
      name: 'Wood Finishes',
    });
    expect(
      (
        await api(owner).post('/categories', {
          name: 'Orphan',
          parentId: '00000000-0000-4000-8000-000000000000',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await api(owner).patch('/categories/00000000-0000-4000-8000-000000000000', { name: 'Nope' }))
        .statusCode,
    ).toBe(404);
  });
});

describe('POST /products', () => {
  it('creates a product family with its pack sizes, prices and barcodes', async () => {
    const asian = await brand('Asian Paints Pro');
    const exterior = await category('Exterior Emulsions');

    const response = await api(owner).post('/products', {
      brandId: asian,
      categoryId: exterior,
      name: 'Apex Ultima',
      type: 'exterior_paint',
      hsnCode: '32091090',
      gstRatePercent: 18,
      variants: [
        {
          sku: 'ap-ult-20l',
          packSize: 20,
          unit: 'l',
          mrpPaise: 1_250_000,
          sellingPricePaise: 1_199_900,
        },
        { sku: 'AP-ULT-1L', packSize: 1, unit: 'l', mrpPaise: 70_000, barcodes: ['4006381333931'] },
        { sku: 'AP-ULT-4L', packSize: 4, unit: 'l' },
        { sku: 'AP-ULT-500ML', packSize: 500, unit: 'ml' },
      ],
    });

    expect(response.statusCode).toBe(201);
    const created = response.json<Product>();
    expect(created).toMatchObject({
      name: 'Apex Ultima',
      type: 'exterior_paint',
      hsnCode: '32091090',
      gstRatePercent: 18,
      brand: { id: asian, name: 'Asian Paints Pro' },
      category: { id: exterior, name: 'Exterior Emulsions', parentId: null },
    });
    expect(created.variants.map((v) => `${String(v.packSize)} ${v.unit}`)).toEqual([
      '500 ml',
      '1 l',
      '4 l',
      '20 l',
    ]);
    expect(created.variants.find((v) => v.sku === 'AP-ULT-20L')).toMatchObject({
      mrpPaise: 1_250_000,
      sellingPricePaise: 1_199_900,
    });
    expect(created.variants.find((v) => v.sku === 'AP-ULT-1L')?.barcodes).toEqual([
      '4006381333931',
    ]);
  });

  it.each([
    [{ hsnCode: '320' }, 'hsnCode'],
    [{ gstRatePercent: 17 }, 'gstRatePercent'],
    [{ type: 'lipstick' }, 'type'],
    [{ variants: [] }, 'variants'],
    [{ variants: [{ sku: 'bad sku!', packSize: 1, unit: 'l' }] }, 'variants.0.sku'],
    [{ variants: [{ sku: 'OK-1', packSize: 0, unit: 'l' }] }, 'variants.0.packSize'],
    [{ variants: [{ sku: 'OK-1', packSize: 1.2345, unit: 'l' }] }, 'variants.0.packSize'],
    [{ variants: [{ sku: 'OK-1', packSize: 1, unit: 'gallon' }] }, 'variants.0.unit'],
    [
      {
        variants: [{ sku: 'OK-1', packSize: 1, unit: 'l', mrpPaise: 100, sellingPricePaise: 101 }],
      },
      'variants.0.sellingPricePaise',
    ],
    [
      { variants: [{ sku: 'OK-1', packSize: 1, unit: 'l', barcodes: ['4006381333932'] }] },
      'variants.0.barcodes.0',
    ],
  ])('answers 400 for %o', async (overrides, field) => {
    const response = await api(owner).post('/products', {
      brandId: await brand(),
      name: 'Invalid Product',
      type: 'primer',
      hsnCode: '3209',
      gstRatePercent: 18,
      variants: [{ sku: 'OK-1', packSize: 1, unit: 'l' }],
      ...overrides,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ issues: { path: string }[] }>().issues.map((i) => i.path)).toContain(
      field,
    );
  });

  it("refuses an unknown or another business's brand, and an unknown category", async () => {
    const rival = await signup('XYZ Paints');
    const rivalBrand = (await api(rival).post('/brands', { name: 'Rival Brand' })).json<{
      id: string;
    }>().id;
    const base = {
      name: 'Orphan',
      type: 'primer',
      hsnCode: '3209',
      gstRatePercent: 18,
      variants: [{ sku: 'ORPHAN-1', packSize: 1, unit: 'l' }],
    };

    const foreign = await api(owner).post('/products', { ...base, brandId: rivalBrand });
    const noCategory = await api(owner).post('/products', {
      ...base,
      brandId: await brand(),
      categoryId: '00000000-0000-4000-8000-000000000000',
    });

    expect(foreign.statusCode).toBe(400);
    expect(foreign.json<{ message: string }>().message).toBe('Unknown brand');
    expect(noCategory.json<{ message: string }>().message).toBe('Unknown category');
  });

  it.each([
    ['product name for the brand', 'name'],
    ['SKU', 'sku'],
    ['pack size', 'pack'],
    ['barcode', 'barcode'],
  ])('refuses a duplicate %s', async (_label, kind) => {
    const n = String(next());
    const brandId = await brand();
    await product({
      brandId,
      name: `Duplicate Test ${n}`,
      variants: [{ sku: `DUP-${n}`, packSize: 1, unit: 'l', barcodes: [`BC-${n}`] }],
    });
    const payloads: Record<string, object> = {
      name: { brandId, name: `DUPLICATE TEST ${n}` },
      sku: { variants: [{ sku: `dup-${n}`, packSize: 1, unit: 'l' }] },
      pack: {
        variants: [
          { sku: `PACK-A-${n}`, packSize: 4, unit: 'l' },
          { sku: `PACK-B-${n}`, packSize: 4, unit: 'l' },
        ],
      },
      barcode: { variants: [{ sku: `BAR-${n}`, packSize: 1, unit: 'l', barcodes: [`BC-${n}`] }] },
    };

    const response = await api(owner).post('/products', {
      brandId: await brand(),
      name: `Other ${n}`,
      type: 'primer',
      hsnCode: '3209',
      gstRatePercent: 18,
      variants: [{ sku: `OTHER-${n}`, packSize: 1, unit: 'l' }],
      ...payloads[kind],
    });

    expect(response.statusCode).toBe(409);
  });

  it('is refused for store staff', async () => {
    const response = await api(storeEmployee).post('/products', {
      brandId: await brand(),
      name: 'Not Allowed',
      type: 'primer',
      hsnCode: '3209',
      gstRatePercent: 18,
      variants: [{ sku: 'NOPE-1', packSize: 1, unit: 'l' }],
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('GET /products', () => {
  let token: string;
  let ids: Record<string, string>;

  beforeAll(async () => {
    token = await signup('Catalogue Paints');
    const make = async (path: string, payload: object) =>
      (await api(token).post(path, payload)).json<{ id: string }>().id;
    const asian = await make('/brands', { name: 'Asian Paints' });
    const berger = await make('/brands', { name: 'berger' });
    const interior = await make('/categories', { name: 'Interior' });
    const emulsions = await make('/categories', { name: 'Emulsions', parentId: interior });
    const base = { hsnCode: '3209', gstRatePercent: 18 };
    ids = {
      royale: await make('/products', {
        ...base,
        brandId: asian,
        categoryId: emulsions,
        name: 'Royale',
        type: 'interior_paint',
        variants: [{ sku: 'AP-ROY-1L', packSize: 1, unit: 'l', barcodes: ['96385074'] }],
      }),
      apex: await make('/products', {
        ...base,
        brandId: asian,
        name: 'Apex',
        type: 'exterior_paint',
        variants: [{ sku: 'AP-APX-1L', packSize: 1, unit: 'l' }],
      }),
      silk: await make('/products', {
        ...base,
        brandId: berger,
        categoryId: interior,
        name: 'Silk',
        type: 'interior_paint',
        variants: [{ sku: 'BG-SLK-1L', packSize: 1, unit: 'l' }],
      }),
      old: await make('/products', {
        ...base,
        brandId: berger,
        name: 'Old Line',
        type: 'enamel',
        variants: [{ sku: 'BG-OLD-1L', packSize: 1, unit: 'l' }],
      }),
    };
    await api(token).patch(`/products/${ids.old ?? ''}`, { isActive: false });
    ids.interior = interior;
    ids.asian = asian;
  });

  const names = async (query: string) =>
    (await api(token).get(`/products${query}`)).json<Page>().items.map((p) => p.name);

  it('lists active products ordered by brand then name, with a total', async () => {
    const page = (await api(token).get('/products')).json<Page>();

    expect(page.items.map((p) => p.name)).toEqual(['Apex', 'Royale', 'Silk']);
    expect(page.total).toBe(3);
  });

  it.each([
    ['?q=roy', ['Royale']],
    ['?q=BERGER', ['Silk']],
    ['?q=bg-slk', ['Silk']],
    ['?q=96385074', ['Royale']],
    ['?type=exterior_paint', ['Apex']],
    ['?includeInactive=true&type=enamel', ['Old Line']],
  ])('filters and searches %s', async (query, expected) => {
    expect(await names(query)).toEqual(expected);
  });

  it('filters by brand, and by category including its subcategories', async () => {
    expect(await names(`?brandId=${ids.asian ?? ''}`)).toEqual(['Apex', 'Royale']);
    expect(await names(`?categoryId=${ids.interior ?? ''}`)).toEqual(['Royale', 'Silk']);
  });

  it('pages through results', async () => {
    const page = (await api(token).get('/products?limit=1&offset=1')).json<Page>();

    expect(page.items.map((p) => p.name)).toEqual(['Royale']);
    expect(page.total).toBe(3);
  });

  it('answers 400 for a bad filter and 404 for an unknown product', async () => {
    expect((await api(token).get('/products?limit=0')).statusCode).toBe(400);
    expect((await api(token).get('/products?brandId=nope')).statusCode).toBe(400);
    expect(
      (await api(token).get('/products/00000000-0000-4000-8000-000000000000')).statusCode,
    ).toBe(404);
    expect((await api(token).get(`/products/${ids.royale ?? ''}`)).json<Product>().name).toBe(
      'Royale',
    );
  });
});

describe('PATCH /products/:id', () => {
  it('renames, re-rates, moves and deactivates a product', async () => {
    const created = await product({ categoryId: await category(`Cat ${String(next())}`) });

    const updated = (
      await api(owner).patch(`/products/${created.id}`, {
        name: 'Renamed',
        gstRatePercent: 5,
        categoryId: null,
        description: 'Low-VOC formula',
        isActive: false,
      })
    ).json<Product>();

    expect(updated).toMatchObject({
      name: 'Renamed',
      gstRatePercent: 5,
      category: null,
      description: 'Low-VOC formula',
      isActive: false,
    });
  });

  it('moves a product to another brand and category', async () => {
    const created = await product();
    const newBrand = await brand();
    const newCategory = await category(`Cat ${String(next())}`);

    const updated = (
      await api(owner).patch(`/products/${created.id}`, {
        brandId: newBrand,
        categoryId: newCategory,
      })
    ).json<Product>();

    expect(updated.brand.id).toBe(newBrand);
    expect(updated.category?.id).toBe(newCategory);
  });

  it('answers 400 for an empty change or unknown brand, and 404 for an unknown product', async () => {
    const created = await product();

    expect((await api(owner).patch(`/products/${created.id}`, {})).statusCode).toBe(400);
    expect(
      (
        await api(owner).patch(`/products/${created.id}`, {
          brandId: '00000000-0000-4000-8000-000000000000',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await api(owner).patch('/products/00000000-0000-4000-8000-000000000000', { name: 'Ghost' }))
        .statusCode,
    ).toBe(404);
  });
});

describe('variants', () => {
  it('adds a pack size to an existing product', async () => {
    const created = await product();

    const response = await api(owner).post(`/products/${created.id}/variants`, {
      sku: `NEW-${String(next())}-10L`,
      packSize: 10,
      unit: 'l',
      mrpPaise: 500_000,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<Product>().variants.map((v) => v.packSize)).toEqual([1, 10]);
  });

  it('refuses a second variant of the same pack size, and a variant for an unknown product', async () => {
    const created = await product();

    expect(
      (
        await api(owner).post(`/products/${created.id}/variants`, {
          sku: `DUP-${String(next())}`,
          packSize: 1,
          unit: 'l',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await api(owner).post('/products/00000000-0000-4000-8000-000000000000/variants', {
          sku: 'GHOST-1',
          packSize: 1,
          unit: 'l',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('changes prices, SKU, barcodes and status', async () => {
    const created = await product();
    const [variant] = created.variants;

    const updated = (
      await api(owner).patch(`/variants/${variant?.id ?? ''}`, {
        sku: `CHANGED-${String(next())}`,
        mrpPaise: 90_000,
        sellingPricePaise: 85_000,
        barcodes: ['10614141000415'],
        isActive: false,
      })
    ).json<Product>().variants[0];

    expect(updated).toMatchObject({
      mrpPaise: 90_000,
      sellingPricePaise: 85_000,
      isActive: false,
      barcodes: ['10614141000415'],
    });
  });

  it('refuses a selling price above the saved MRP', async () => {
    const created = await product({
      variants: [{ sku: `MRP-${String(next())}`, packSize: 1, unit: 'l', mrpPaise: 50_000 }],
    });

    const response = await api(owner).patch(`/variants/${created.variants[0]?.id ?? ''}`, {
      sellingPricePaise: 50_001,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toBe(
      'Selling price cannot exceed the MRP',
    );
  });

  it('clears the MRP with null', async () => {
    const created = await product({
      variants: [{ sku: `CLR-${String(next())}`, packSize: 1, unit: 'l', mrpPaise: 50_000 }],
    });

    const updated = (
      await api(owner).patch(`/variants/${created.variants[0]?.id ?? ''}`, { mrpPaise: null })
    ).json<Product>();

    expect(updated.variants[0]?.mrpPaise).toBeNull();
  });

  it('answers 404 for an unknown variant and 400 for an empty change', async () => {
    const created = await product();

    expect(
      (
        await api(owner).patch('/variants/00000000-0000-4000-8000-000000000000', {
          isActive: false,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await api(owner).patch(`/variants/${created.variants[0]?.id ?? ''}`, {})).statusCode,
    ).toBe(400);
  });
});

describe('GET /products/lookup', () => {
  it('finds a variant by scanned barcode or typed SKU', async () => {
    const created = await product({
      variants: [
        { sku: `SCAN-${String(next())}`, packSize: 1, unit: 'l', barcodes: ['4012345678901'] },
      ],
    });
    const [variant] = created.variants;

    const byBarcode = (await api(storeEmployee).get('/products/lookup?code=4012345678901')).json<{
      product: Product;
      variant: Variant;
    }>();
    const bySku = await api(storeEmployee).get(
      `/products/lookup?code=${variant?.sku.toLowerCase() ?? ''}`,
    );

    expect(byBarcode.product.id).toBe(created.id);
    expect(byBarcode.variant.id).toBe(variant?.id);
    expect(bySku.json<{ variant: Variant }>().variant.id).toBe(variant?.id);
  });

  it('answers 404 for an unknown code and 400 without one', async () => {
    expect((await api(owner).get('/products/lookup?code=NOTHING-HERE')).statusCode).toBe(404);
    expect((await api(owner).get('/products/lookup')).statusCode).toBe(400);
  });
});

describe('another business', () => {
  it("cannot see ABC Paints' catalogue", async () => {
    const created = await product({
      variants: [
        { sku: `PRIV-${String(next())}`, packSize: 1, unit: 'l', barcodes: ['5901234123457'] },
      ],
    });
    const rival = await signup('Rival Paints');

    expect((await api(rival).get('/products')).json<Page>().items).toEqual([]);
    expect((await api(rival).get(`/products/${created.id}`)).statusCode).toBe(404);
    expect((await api(rival).get('/products/lookup?code=5901234123457')).statusCode).toBe(404);
  });
});

describe('without signing in', () => {
  it('answers 401', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/products' })).statusCode).toBe(401);
  });
});
