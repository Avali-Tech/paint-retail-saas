import { migrateDatabase, schema } from '@paint/db';
import {
  gstinCheckCharacter,
  type GstRegistrations,
  type TaxCategoryOptions,
  type TaxCategoryView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { istDate } from '../test-support/business.js';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

let database: TestDatabase;
let t: TestApp;

/** A GSTIN with a correct check character: state code, PAN, entity number. */
const gstin = (state: string, pan = 'AABCS1429B', entity = '1') => {
  const first14 = `${state}${pan}${entity}Z`;
  return `${first14}${gstinCheckCharacter(first14)}`;
};

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object = {}) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  patch: (url: string, payload: object) =>
    t.app.inject({ method: 'PATCH', url, headers: bearer(token), payload }),
  put: (url: string, payload: object) =>
    t.app.inject({ method: 'PUT', url, headers: bearer(token), payload }),
});

interface Business {
  readonly owner: string;
  readonly organizationId: string;
  readonly hyd: string;
  readonly vjw: string;
  readonly brandId: string;
  /** Logs in a new member with a role made of `permissions`, at `storeIds` only. */
  member(permissions: string[], storeIds: string[]): Promise<string>;
}

let counter = 0;
async function business(): Promise<Business> {
  counter += 1;
  const signup = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: `Tax Paints ${String(counter)}`,
      fullName: 'Owner',
      phone: uniquePhone(),
      password: 'Rangoli@2026',
    },
  });
  const { token: owner, organizationId } = signup.json<{ token: string; organizationId: string }>();
  const o = api(owner);
  const hyd = (await o.post('/stores', { name: 'Ameerpet', code: 'HYD' })).json<{ id: string }>()
    .id;
  const vjw = (await o.post('/stores', { name: 'Vijayawada', code: 'VJW' })).json<{ id: string }>()
    .id;
  const brandId = (await o.post('/brands', { name: 'Asian Paints' })).json<{ id: string }>().id;
  return {
    owner,
    organizationId,
    hyd,
    vjw,
    brandId,
    async member(permissions, storeIds) {
      const role = (
        await o.post('/roles', { name: `Role ${String(++counter)}`, permissions })
      ).json<{ id: string }>();
      const phone = uniquePhone();
      await o.post('/members', {
        fullName: 'Staff',
        phone,
        password: 'Staff@2026',
        roleId: role.id,
        storeIds,
      });
      const login = await t.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { identifier: phone, password: 'Staff@2026' },
      });
      return login.json<{ token: string }>().token;
    },
  };
}

const categories = async (token: string) =>
  (await api(token).get('/tax-categories')).json<TaxCategoryView[]>();
const byName = async (token: string, name: string) => {
  const found = (await categories(token)).find((category) => category.name === name);
  if (!found) throw new Error(`No category ${name}`);
  return found;
};
const issues = (response: Awaited<ReturnType<TestApp['app']['inject']>>) =>
  response.json<{ issues: { path: string; message: string }[] }>().issues;

const register = (b: Business, storeId: string, body: object) =>
  api(b.owner).put(`/gst-registrations/stores/${storeId}`, body);

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('tax categories', () => {
  it('starts every business with the default categories at 18% (Exempt at 0%)', async () => {
    const b = await business();
    const list = await categories(b.owner);
    expect(
      list.map(({ name, key, isDefault, currentRateBps }) => [
        name,
        key,
        isDefault,
        currentRateBps,
      ]),
    ).toEqual([
      ['Brushes & rollers 18%', 'brushes_rollers', false, 1800],
      ['Exempt', 'exempt', false, 0],
      ['Paints 18%', 'paints', true, 1800],
      ['Putty & fillers 18%', 'putty', false, 1800],
      ['Tools 18%', 'tools', false, 1800],
      ['Varnishes & wood finishes 18%', 'varnishes', false, 1800],
    ]);
    expect(list[0]?.rates).toEqual([
      { id: expect.any(String), rateBps: 1800, effectiveFrom: '2025-09-22', effectiveTo: null },
    ]);
  });

  it('lets only tax readers see the history; whoever reads the catalogue gets the options', async () => {
    const b = await business();
    const clerk = await b.member(['catalog:read', 'stores:read'], [b.hyd]);
    expect((await api(clerk).get('/tax-categories')).statusCode).toBe(403);
    const options = (await api(clerk).get('/tax-categories/options')).json<TaxCategoryOptions>();
    expect(options.gstRegistered).toBe(false);
    expect(options.categories).toHaveLength(6);
    expect(options.categories.find((option) => option.isDefault)).toMatchObject({
      name: 'Paints 18%',
      currentRateBps: 1800,
    });
    expect((await api(clerk).post('/tax-categories', { name: 'X', rateBps: 0 })).statusCode).toBe(
      403,
    );
  });

  it('adds a category from today or from a given day, refusing duplicates and bad rates', async () => {
    const b = await business();
    const o = api(b.owner);
    const today = await o.post('/tax-categories', { name: 'Adhesives 18%', rateBps: 1800 });
    expect(today.statusCode).toBe(201);
    expect(today.json<TaxCategoryView>()).toMatchObject({
      name: 'Adhesives 18%',
      key: null,
      isDefault: false,
      isActive: true,
      currentRateBps: 1800,
    });
    const later = await o.post('/tax-categories', {
      name: 'Future 5%',
      rateBps: 500,
      effectiveFrom: istDate(30),
    });
    expect(later.json<TaxCategoryView>()).toMatchObject({
      currentRateBps: null,
      rates: [{ rateBps: 500, effectiveFrom: istDate(30), effectiveTo: null }],
    });
    expect(
      (await o.post('/tax-categories', { name: 'adhesives 18%', rateBps: 0 })).statusCode,
    ).toBe(409);
    const bad = await o.post('/tax-categories', {
      name: 'Bad',
      rateBps: 10_001,
      effectiveFrom: 'x',
    });
    expect(issues(bad).map((issue) => issue.path)).toEqual(['rateBps', 'effectiveFrom']);
  });

  it('renames, moves the default, and deactivates, keeping a default always', async () => {
    const b = await business();
    const o = api(b.owner);
    const paints = await byName(b.owner, 'Paints 18%');
    const tools = await byName(b.owner, 'Tools 18%');

    const refused = await o.patch(`/tax-categories/${paints.id}`, { isActive: false });
    expect(issues(refused)).toEqual([
      { path: 'isActive', message: 'Make another category the default first' },
    ]);
    const both = await o.patch(`/tax-categories/${tools.id}`, { isActive: false, isDefault: true });
    expect(issues(both)[0]?.path).toBe('isDefault');

    const moved = await o.patch(`/tax-categories/${tools.id}`, {
      name: 'Hand tools 18%',
      isDefault: true,
    });
    expect(moved.json<TaxCategoryView>()).toMatchObject({
      name: 'Hand tools 18%',
      isDefault: true,
    });
    const off = await o.patch(`/tax-categories/${paints.id}`, { isActive: false });
    expect(off.json<TaxCategoryView>()).toMatchObject({ isActive: false, isDefault: false });
    // Inactive categories are listed last and left out of the options.
    expect((await categories(b.owner)).at(-1)?.name).toBe('Paints 18%');
    const options = (await o.get('/tax-categories/options')).json<TaxCategoryOptions>();
    expect(options.categories.map((option) => option.name)).not.toContain('Paints 18%');

    expect((await o.patch(`/tax-categories/${tools.id}`, {})).statusCode).toBe(400);
    expect((await o.patch(`/tax-categories/${tools.id}`, { name: 'Exempt' })).statusCode).toBe(409);
    expect(
      (await o.patch('/tax-categories/00000000-0000-4000-8000-000000000000', { name: 'Nope' }))
        .statusCode,
    ).toBe(404);
  });

  it('adds a new rate from today or later, closing the previous one; past rates stay', async () => {
    const b = await business();
    const o = api(b.owner);
    const putty = await byName(b.owner, 'Putty & fillers 18%');
    const url = `/tax-categories/${putty.id}/rates`;

    const past = await o.post(url, { rateBps: 500, effectiveFrom: istDate(-30) });
    expect(issues(past)).toEqual([
      {
        path: 'effectiveFrom',
        message: 'A new rate starts today or later; past rates stay as they were',
      },
    ]);
    const added = await o.post(url, { rateBps: 1200, effectiveFrom: istDate(30) });
    expect(added.statusCode).toBe(201);
    expect(added.json<TaxCategoryView>()).toMatchObject({
      currentRateBps: 1800,
      rates: [
        { rateBps: 1800, effectiveFrom: '2025-09-22', effectiveTo: istDate(29) },
        { rateBps: 1200, effectiveFrom: istDate(30), effectiveTo: null },
      ],
    });
    const before = await o.post(url, { rateBps: 500, effectiveFrom: istDate(20) });
    expect(issues(before)).toEqual([
      { path: 'effectiveFrom', message: `A new rate must start after ${istDate(30)}` },
    ]);
    expect(
      (
        await o.post('/tax-categories/00000000-0000-4000-8000-000000000000/rates', {
          rateBps: 500,
          effectiveFrom: istDate(40),
        })
      ).statusCode,
    ).toBe(404);
  });

  it("never shows or changes another business's categories", async () => {
    const a = await business();
    const b = await business();
    const theirs = await byName(b.owner, 'Exempt');
    expect((await categories(a.owner)).map((category) => category.id)).not.toContain(theirs.id);
    expect(
      (await api(a.owner).patch(`/tax-categories/${theirs.id}`, { name: 'Mine' })).statusCode,
    ).toBe(404);
    expect(
      (
        await api(a.owner).post(`/tax-categories/${theirs.id}/rates`, {
          rateBps: 500,
          effectiveFrom: istDate(10),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('records categories and rates in the audit log under who changed them', async () => {
    const b = await business();
    const o = api(b.owner);
    const exempt = await byName(b.owner, 'Exempt');
    await o.patch(`/tax-categories/${exempt.id}`, { name: 'Nil rated' });
    await o.post(`/tax-categories/${exempt.id}/rates`, { rateBps: 500, effectiveFrom: istDate(5) });

    const page = (await o.get('/audit-log?table=tax_rates&limit=2')).json<{
      items: {
        actor: { name: string } | null;
        area: string;
        recordLabel: string;
        action: string;
        changes: { field: string; newText: string | null }[];
      }[];
    }>();
    expect(page.items.map((item) => [item.action, item.area, item.recordLabel])).toEqual([
      ['insert', 'Tax rates', 'Nil rated'],
      ['update', 'Tax rates', 'Nil rated'],
    ]);
    expect(page.items[0]?.actor?.name).toBe('Owner');
    expect(page.items[0]?.changes.find((c) => c.field === 'tax_category_id')?.newText).toBe(
      'Nil rated',
    );
    const renamed = (await o.get('/audit-log?table=tax_categories&limit=1')).json<{
      items: { recordLabel: string; changes: { field: string; oldText: string }[] }[];
    }>();
    expect(renamed.items[0]).toMatchObject({
      recordLabel: 'Nil rated',
      changes: [{ field: 'name', oldText: 'Exempt' }],
    });
  });
});

describe('GST registrations', () => {
  it('registers stores per state with one PAN, defaulting the legal name to the business', async () => {
    const b = await business();
    const o = api(b.owner);
    const empty = (await o.get('/gst-registrations')).json<GstRegistrations>();
    expect(empty).toMatchObject({ legalName: null, pan: null });
    expect(empty.stores.map((store) => [store.code, store.registrationType])).toEqual([
      ['HYD', 'unregistered'],
      ['VJW', 'unregistered'],
    ]);

    const noName = await register(b, b.hyd, {
      registrationType: 'regular',
      stateCode: '36',
      gstin: gstin('36'),
    });
    expect(issues(noName)[0]?.path).toBe('legalName');

    const named = await o.put('/gst-registrations/business', {
      legalName: 'Sharma Paints Private Limited',
    });
    expect(named.json<GstRegistrations>().legalName).toBe('Sharma Paints Private Limited');
    const hyd = await register(b, b.hyd, {
      registrationType: 'regular',
      stateCode: '36',
      gstin: gstin('36').toLowerCase(),
      tradeName: 'Sharma Paints',
      addressLine: '1-2-3 Ameerpet Main Road',
      city: 'Hyderabad',
      pincode: '500016',
    });
    expect(hyd.statusCode).toBe(200);
    const vjw = await register(b, b.vjw, {
      registrationType: 'composition',
      stateCode: '37',
      gstin: gstin('37'),
      legalName: 'Sharma Paints Pvt Ltd',
    });
    const saved = vjw.json<GstRegistrations>();
    expect(saved).toMatchObject({ pan: 'AABCS1429B' });
    expect(saved.stores).toEqual([
      {
        storeId: b.hyd,
        code: 'HYD',
        name: 'Ameerpet',
        registrationType: 'regular',
        stateCode: '36',
        gstin: gstin('36'),
        legalName: 'Sharma Paints Private Limited',
        tradeName: 'Sharma Paints',
        addressLine: '1-2-3 Ameerpet Main Road',
        city: 'Hyderabad',
        pincode: '500016',
      },
      {
        storeId: b.vjw,
        code: 'VJW',
        name: 'Vijayawada',
        registrationType: 'composition',
        stateCode: '37',
        gstin: gstin('37'),
        legalName: 'Sharma Paints Pvt Ltd',
        tradeName: null,
        addressLine: null,
        city: null,
        pincode: null,
      },
    ]);
    // The store's address state follows its registration.
    const store = (await o.get(`/stores/${b.vjw}`)).json<{ state: string }>();
    expect(store.state).toBe('Andhra Pradesh');

    const otherPan = await register(b, b.vjw, {
      registrationType: 'regular',
      stateCode: '37',
      gstin: gstin('37', 'AAAPL1234C'),
    });
    expect(issues(otherPan)).toEqual([
      {
        path: 'gstin',
        message: "This GSTIN has another PAN than the business's other registrations",
      },
    ]);

    const unregistered = await register(b, b.vjw, {
      registrationType: 'unregistered',
      stateCode: '37',
      city: 'Vijayawada',
    });
    expect(unregistered.json<GstRegistrations>().stores[1]).toMatchObject({
      registrationType: 'unregistered',
      gstin: null,
      legalName: null,
      tradeName: null,
      city: 'Vijayawada',
    });

    const audit = (await o.get('/audit-log?table=stores&limit=1')).json<{
      items: { recordLabel: string; area: string; changes: { field: string }[] }[];
    }>();
    expect(audit.items[0]).toMatchObject({
      recordLabel: 'VJW · Vijayawada',
      area: 'GST registrations',
    });
    expect(audit.items[0]?.changes.map((change) => change.field)).toContain(
      'gst_registration_type',
    );
  });

  it('checks the GSTIN against the state, the type and its check character', async () => {
    const b = await business();
    const cases: [object, string, string][] = [
      [
        { registrationType: 'regular', stateCode: '37', gstin: gstin('36') },
        'gstin',
        'This GSTIN belongs to another state',
      ],
      [
        { registrationType: 'regular', stateCode: '36' },
        'gstin',
        'Enter the GSTIN of this registration',
      ],
      [
        { registrationType: 'unregistered', stateCode: '36', gstin: gstin('36') },
        'gstin',
        'An unregistered store has no GSTIN',
      ],
      [
        { registrationType: 'regular', stateCode: '36', gstin: `${gstin('36').slice(0, 14)}0` },
        'gstin',
        'Enter a valid GSTIN (check for typos)',
      ],
      [{ registrationType: 'unregistered', stateCode: '28' }, 'stateCode', 'Choose a state'],
      [
        { registrationType: 'unregistered', stateCode: '36', pincode: '012345' },
        'pincode',
        'Enter a 6-digit PIN code',
      ],
    ];
    for (const [body, path, message] of cases) {
      expect(issues(await register(b, b.hyd, body))).toContainEqual({ path, message });
    }
    expect(
      (
        await register(b, '00000000-0000-4000-8000-000000000000', {
          registrationType: 'unregistered',
          stateCode: '36',
        })
      ).statusCode,
    ).toBe(404);
  });

  it("keeps a member to their stores' registrations, and others out", async () => {
    const b = await business();
    const accountant = await b.member(['tax:read', 'tax:manage', 'stores:read'], [b.hyd]);
    const seen = (await api(accountant).get('/gst-registrations')).json<GstRegistrations>();
    expect(seen.stores.map((store) => store.code)).toEqual(['HYD']);
    const elsewhere = await api(accountant).put(`/gst-registrations/stores/${b.vjw}`, {
      registrationType: 'unregistered',
      stateCode: '37',
    });
    expect(elsewhere.statusCode).toBe(404);

    const clerk = await b.member(['catalog:read'], [b.hyd]);
    expect((await api(clerk).get('/gst-registrations')).statusCode).toBe(403);
    const other = await business();
    expect(
      (
        await api(other.owner).put(`/gst-registrations/stores/${b.hyd}`, {
          registrationType: 'unregistered',
          stateCode: '36',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('products and tax categories', () => {
  const product = (b: Business, body: object = {}) =>
    api(b.owner).post('/products', {
      brandId: b.brandId,
      name: `Product ${String(++counter)}`,
      type: 'putty',
      hsnCode: '3214',
      variants: [{ sku: `TX-${String(counter)}`, packSize: 1, unit: 'kg' }],
      ...body,
    });

  it('gives a new product the default category until the business registers, then asks for one', async () => {
    const b = await business();
    const putty = await byName(b.owner, 'Putty & fillers 18%');

    const plain = await product(b);
    expect(plain.json()).toMatchObject({
      hsnCode: '3214',
      gstRatePercent: 18,
      taxCategory: { name: 'Paints 18%' },
    });
    await api(b.owner).put('/gst-registrations/business', { legalName: 'Tax Paints LLP' });
    await register(b, b.hyd, { registrationType: 'regular', stateCode: '36', gstin: gstin('36') });

    expect(issues(await product(b))).toEqual([
      {
        path: 'taxCategoryId',
        message: 'Choose a tax category: the business is registered for GST',
      },
    ]);
    const chosen = await product(b, { taxCategoryId: putty.id });
    expect(chosen.json()).toMatchObject({ taxCategory: { id: putty.id, name: putty.name } });
    const options = (await api(b.owner).get('/tax-categories/options')).json<TaxCategoryOptions>();
    expect(options.gstRegistered).toBe(true);
    // Existing products can still be edited without choosing again.
    const renamed = await api(b.owner).patch(`/products/${plain.json<{ id: string }>().id}`, {
      name: 'Renamed putty',
    });
    expect(renamed.json()).toMatchObject({ taxCategory: { name: 'Paints 18%' } });
  });

  it('refuses unknown and inactive categories, and shows the rate in force today', async () => {
    const b = await business();
    const o = api(b.owner);
    const tools = await byName(b.owner, 'Tools 18%');
    await o.patch(`/tax-categories/${tools.id}`, { isActive: false });
    expect((await product(b, { taxCategoryId: tools.id })).json()).toMatchObject({
      message: 'This tax category is inactive. Reactivate it first.',
    });
    expect(
      (await product(b, { taxCategoryId: '00000000-0000-4000-8000-000000000000' })).json(),
    ).toMatchObject({ message: 'Unknown tax category' });

    const later = (
      await o.post('/tax-categories', {
        name: 'Starts later 5%',
        rateBps: 500,
        effectiveFrom: istDate(10),
      })
    ).json<TaxCategoryView>();
    const early = await product(b, { taxCategoryId: later.id });
    expect(early.json()).toMatchObject({ gstRatePercent: 5 });
    // A rate scheduled for later does not change today's.
    const exempt = await byName(b.owner, 'Exempt');
    const free = (await product(b, { taxCategoryId: exempt.id })).json<{ id: string }>();
    await o.post(`/tax-categories/${exempt.id}/rates`, { rateBps: 500, effectiveFrom: istDate(3) });
    expect((await o.get(`/products/${free.id}`)).json()).toMatchObject({ gstRatePercent: 0 });
  });

  it('shows a product saved without a category by the previous release with its own rate', async () => {
    const b = await business();
    const created = (await product(b)).json<{ id: string }>();
    await t.connection.db
      .update(schema.products)
      .set({ taxCategoryId: null, gstRateBps: 2800 })
      .where(eq(schema.products.id, created.id));
    expect((await api(b.owner).get(`/products/${created.id}`)).json()).toMatchObject({
      taxCategory: null,
      gstRatePercent: 28,
    });
  });
});

describe('product import and tax categories', () => {
  const header = 'brand,product,type,hsn_code,tax_category,sku,pack_size,unit';
  const csv = (...rows: string[]) => [header, ...rows].join('\n');
  const send = (b: Business, file: string, mode: 'preview' | 'commit' = 'commit') =>
    api(b.owner).post(mode === 'preview' ? '/imports/products/preview' : '/imports/products', {
      csv: file,
    });
  const errors = (response: Awaited<ReturnType<TestApp['app']['inject']>>) =>
    response
      .json<{ errors: { row: number; column: string; message: string }[] }>()
      .errors.map(({ row, column, message }) => [row, column, message]);
  const taxOf = async (b: Business, sku: string) =>
    (await api(b.owner).get(`/products/lookup?code=${sku}`)).json<{
      product: { taxCategory: { name: string } | null };
    }>().product.taxCategory?.name;

  it('takes the category by name, keeps it when blank, and defaults new products', async () => {
    const b = await business();
    const first = await send(
      b,
      csv(
        'Asian,Trucare Putty,putty,3214,putty & fillers 18%,IM-P1,1,kg',
        'Asian,Apex,exterior_paint,3209,,IM-A1,1,l',
      ),
    );
    expect(first.statusCode).toBe(201);
    expect(await taxOf(b, 'IM-P1')).toBe('Putty & fillers 18%');
    expect(await taxOf(b, 'IM-A1')).toBe('Paints 18%');

    const again = await send(
      b,
      csv(
        'Asian,Trucare Putty,putty,3214,,IM-P1,1,kg',
        'Asian,Apex,exterior_paint,3209,Exempt,IM-A1,1,l',
      ),
    );
    expect(
      again.json<{ rows: { row: number; action: string }[] }>().rows.map((row) => row.action),
    ).toEqual(['unchanged', 'update']);
    expect(await taxOf(b, 'IM-P1')).toBe('Putty & fillers 18%');
    expect(await taxOf(b, 'IM-A1')).toBe('Exempt');
  });

  it('refuses unknown and inactive categories, and blanks for new products once registered', async () => {
    const b = await business();
    await send(b, csv('Asian,Old Tool,tool,8205,Tools 18%,IM-T1,1,piece'));
    const tools = await byName(b.owner, 'Tools 18%');
    await api(b.owner).patch(`/tax-categories/${tools.id}`, { isActive: false });
    await api(b.owner).put('/gst-registrations/business', { legalName: 'Tax Paints LLP' });
    await register(b, b.hyd, { registrationType: 'regular', stateCode: '36', gstin: gstin('36') });

    const response = await send(
      b,
      csv(
        'Asian,Old Tool,tool,8205,Tools 18%,IM-T1,1,piece',
        'Asian,New Tool,tool,8205,Tools 18%,IM-T2,1,piece',
        'Asian,Mystery,other,3209,Luxury 99%,IM-M1,1,l',
        'Asian,Blank,other,3209,,IM-B1,1,l',
      ),
      'preview',
    );
    expect(errors(response)).toEqual([
      [3, 'tax_category', 'Tools 18% is inactive. Reactivate it first.'],
      [4, 'tax_category', 'Unknown tax category; see Settings, Tax & GST'],
      [5, 'tax_category', 'Required: the business is registered for GST'],
    ]);
  });
});

describe('place of supply', () => {
  it('follows the GSTIN, is entered without one, and must not contradict it', async () => {
    const b = await business();
    const o = api(b.owner);
    const withGstin = await o.post('/parties', {
      displayName: 'Vizag Builders',
      kind: 'organization',
      gstin: gstin('37', 'AAACV1234D'),
      roles: ['customer'],
    });
    expect(withGstin.json()).toMatchObject({ placeOfSupply: '37', pan: 'AAACV1234D' });
    const id = withGstin.json<{ id: string }>().id;

    const contradicting = await o.post('/parties', {
      displayName: 'Mismatch',
      gstin: gstin('36', 'AAACM1234E'),
      placeOfSupply: '37',
      roles: ['customer'],
    });
    expect(issues(contradicting)).toEqual([
      { path: 'placeOfSupply', message: "The GSTIN's state is the place of supply" },
    ]);
    const matching = await o.post('/parties', {
      displayName: 'Match',
      gstin: gstin('36', 'AAACM1234E'),
      placeOfSupply: '36',
      roles: ['customer'],
    });
    expect(matching.json()).toMatchObject({ placeOfSupply: '36' });

    const walkIn = await o.post('/parties', {
      displayName: 'Guntur Walk-in',
      placeOfSupply: '37',
      roles: ['customer'],
    });
    expect(walkIn.json()).toMatchObject({ placeOfSupply: '37', gstin: null });
    const walkInId = walkIn.json<{ id: string }>().id;
    expect((await o.patch(`/parties/${walkInId}`, { placeOfSupply: '36' })).json()).toMatchObject({
      placeOfSupply: '36',
    });
    expect((await o.patch(`/parties/${walkInId}`, { placeOfSupply: '25' })).statusCode).toBe(400);

    expect(issues(await o.patch(`/parties/${id}`, { placeOfSupply: '36' }))[0]?.path).toBe(
      'placeOfSupply',
    );
    const cleared = await o.patch(`/parties/${id}`, { gstin: null, placeOfSupply: '36' });
    expect(cleared.json()).toMatchObject({ gstin: null, placeOfSupply: '36' });
  });
});
