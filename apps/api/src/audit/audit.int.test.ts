import { migrateDatabase } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import type { AuditEntry, AuditPage } from './audit.service.js';

let database: TestDatabase;
let t: TestApp;
let owner: string;
let manager: string;
let hyd: string;
let pune: string;
let managerId: string;
let variantId: string;

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object = {}) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  patch: (url: string, payload: object) =>
    t.app.inject({ method: 'PATCH', url, headers: bearer(token), payload }),
});
const log = async (query = '') => (await api(owner).get(`/audit-log?${query}`)).json<AuditPage>();
const changes = (entry: AuditEntry | undefined) =>
  entry?.changes.map((c) => [c.label, c.oldText, c.newText]);

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  const response = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: 'ABC Paints',
      fullName: 'Anil Owner',
      phone: uniquePhone(),
      password: 'Staff@2026',
    },
  });
  owner = response.json<{ token: string }>().token;
  hyd = (await api(owner).post('/stores', { name: 'Hyderabad', code: 'HYD' })).json<{
    id: string;
  }>().id;
  pune = (await api(owner).post('/stores', { name: 'Pune', code: 'PUN' })).json<{ id: string }>()
    .id;
  const roles = (await api(owner).get('/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  managerId = (
    await api(owner).post('/members', {
      fullName: 'Hyd Manager',
      phone,
      password: 'Staff@2026',
      roleId: roles.find((role) => role.key === 'branch_manager')?.id,
      storeIds: [hyd],
    })
  ).json<{ id: string }>().id;
  manager = (
    await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { identifier: phone, password: 'Staff@2026' },
    })
  ).json<{ token: string }>().token;
  const brandId = (await api(owner).post('/brands', { name: 'Asian Paints' })).json<{
    id: string;
  }>().id;
  variantId = String(
    (
      await api(owner).post('/products', {
        brandId,
        name: 'Apex',
        type: 'exterior_paint',
        hsnCode: '3209',
        variants: [
          { sku: 'APX-1L', packSize: 1, unit: 'l', mrpPaise: 65_000, sellingPricePaise: 60_000 },
        ],
      })
    ).json<{ variants: { id: string }[] }>().variants[0]?.id,
  );
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('audit log', () => {
  it('shows who changed a price, from what to what', async () => {
    await api(owner).patch(`/variants/${variantId}`, { sellingPricePaise: 62_500 });

    const [entry] = (await log('table=product_variants')).items;

    expect(entry).toMatchObject({
      actor: { name: 'Anil Owner' },
      area: 'Product prices and pack sizes',
      recordId: variantId,
      recordLabel: 'APX-1L',
      action: 'update',
    });
    expect(changes(entry)).toEqual([['Selling price', '₹600.00', '₹625.00']]);
    expect(entry?.changes[0]).toMatchObject({
      field: 'selling_price_paise',
      old: 60_000,
      new: 62_500,
    });
  });

  it('shows brands, categories, products and pack sizes being deactivated, renamed and moved', async () => {
    const brand = (await api(owner).post('/brands', { name: 'Old Brand' })).json<{ id: string }>();
    const other = (await api(owner).post('/brands', { name: 'New Brand' })).json<{ id: string }>();
    const category = (await api(owner).post('/categories', { name: 'Primers' })).json<{
      id: string;
    }>();
    const product = (
      await api(owner).post('/products', {
        brandId: brand.id,
        categoryId: category.id,
        name: 'Lifecycle Primer',
        type: 'primer',
        hsnCode: '3209',
        variants: [{ sku: 'LCP-1L', packSize: 1, unit: 'l' }],
      })
    ).json<{ id: string; variants: { id: string }[] }>();
    await api(owner).patch(`/products/${product.id}`, { brandId: other.id, isActive: false });
    await api(owner).patch(`/variants/${String(product.variants[0]?.id)}`, { isActive: false });
    await api(owner).patch(`/brands/${brand.id}`, { name: 'Retired Brand', isActive: false });
    await api(owner).patch(`/categories/${category.id}`, { isActive: false });

    const entry = async (table: string) => (await log(`table=${table}&limit=1`)).items[0];

    expect(await entry('brands')).toMatchObject({ area: 'Brands', recordLabel: 'Retired Brand' });
    expect(changes(await entry('brands'))).toEqual([
      ['Name', 'Old Brand', 'Retired Brand'],
      ['Active', 'Yes', 'No'],
    ]);
    expect(changes(await entry('categories'))).toEqual([['Active', 'Yes', 'No']]);
    expect(await entry('categories')).toMatchObject({ area: 'Categories', recordLabel: 'Primers' });
    expect(await entry('products')).toMatchObject({
      area: 'Products',
      recordLabel: 'Lifecycle Primer',
      actor: { name: 'Anil Owner' },
    });
    expect(changes(await entry('products'))).toEqual([
      ['Active', 'Yes', 'No'],
      ['Brand', 'Retired Brand', 'New Brand'],
    ]);
    expect(changes(await entry('product_variants'))).toEqual([['Active', 'Yes', 'No']]);
  });

  it('shows a subcategory being renamed', async () => {
    const walls = (await api(owner).post('/categories', { name: 'Walls' })).json<{ id: string }>();
    const sub = (await api(owner).post('/categories', { name: 'Putty', parentId: walls.id })).json<{
      id: string;
    }>();
    await api(owner).patch(`/categories/${sub.id}`, { name: 'Wall Putty' });

    const [entry] = (await log(`recordId=${sub.id}`)).items;

    expect(changes(entry)).toEqual([['Name', 'Putty', 'Wall Putty']]);
  });

  it('shows changes to a member’s role, stores and access', async () => {
    const roles = (await api(owner).get('/roles')).json<
      { id: string; key: string; name: string }[]
    >();
    const salesRole = roles.find((role) => role.key === 'sales_executive');
    await api(owner).patch(`/members/${managerId}`, {
      roleId: salesRole?.id,
      storeIds: [hyd, pune],
    });
    await api(owner).patch(`/members/${managerId}`, { storeIds: [pune] });
    await api(owner).patch(`/members/${managerId}`, { isActive: false });

    const member = await log(`recordId=${managerId}`);

    expect(member.items.map((e) => [e.area, e.action, changes(e)])).toEqual([
      ['Member access', 'update', [['Active', 'Yes', 'No']]],
      ['Member stores', 'delete', [['Store', 'HYD', null]]],
      // Only the store that was added: the existing one is untouched.
      ['Member stores', 'insert', [['Store', null, 'PUN']]],
      ['Member access', 'update', [['Role', 'Branch Manager', 'Sales Executive']]],
      ['Member stores', 'insert', [['Store', null, 'HYD']]],
      [
        'Member access',
        'insert',
        [
          ['Role', null, 'Branch Manager'],
          ['All stores', null, 'No'],
          ['Active', null, 'Yes'],
          ['Two-factor reset', null, null],
        ],
      ],
    ]);
    expect(
      member.items.every((e) => e.recordLabel === 'Hyd Manager' && e.actor?.name === 'Anil Owner'),
    ).toBe(true);
  });

  it('shows stock adjustments and write-offs', async () => {
    await api(owner).post('/stock/movements', {
      storeId: hyd,
      type: 'opening',
      lines: [{ variantId, quantity: 10 }],
    });
    await api(owner).post('/stock/movements', {
      storeId: hyd,
      type: 'damage',
      note: 'Tin dented in unloading',
      lines: [{ variantId, quantity: 2 }],
    });

    const { items, total } = await log('table=stock_ledger');

    expect(total).toBe(1);
    expect(items[0]).toMatchObject({
      area: 'Stock adjustments',
      recordLabel: 'APX-1L',
      action: 'insert',
    });
    expect(changes(items[0])).toEqual([
      ['Store', null, 'HYD'],
      ['Product', null, 'APX-1L'],
      ['Type', null, 'damage'],
      ['Quantity', null, '-2'],
      ['Note', null, 'Tin dented in unloading'],
    ]);
  });

  it('shows the roles set up for a new business as system work', async () => {
    const roles = await log('table=role_permissions&limit=1');
    const setUp = (await log('table=roles&limit=200')).items.filter((e) => e.action === 'insert');

    expect(roles.total).toBeGreaterThan(20);
    expect(roles.items[0]?.changes[0]?.label).toBe('Permission');
    expect(setUp).toHaveLength(7);
    expect(setUp.every((e) => e.actor === null && e.area === 'Roles')).toBe(true);
    expect(setUp.map((e) => e.recordLabel)).toContain('Owner');
  });

  it('filters by who made the change and when, newest first', async () => {
    const all = await log('limit=200');
    const ownerId = all.items.find((e) => e.actor)?.actor?.memberId;
    // The database's own times: the business was set up in one transaction.
    const setUpAt = String(
      all.items.find((e) => e.table === 'roles' && e.actor === null)?.occurredAt,
    );
    const justAfter = new Date(Date.parse(setUpAt) + 1).toISOString();

    const byOwner = await log(`actorMemberId=${String(ownerId)}&limit=200`);
    const upToSetUp = await log(`to=${encodeURIComponent(setUpAt)}&limit=200`);
    const afterSetUp = await log(`from=${encodeURIComponent(justAfter)}&limit=200`);

    expect(all.items.map((e) => e.id)).toEqual(
      [...all.items.map((e) => e.id)].sort((a, b) => b - a),
    );
    expect(byOwner.items.every((e) => e.actor?.memberId === ownerId)).toBe(true);
    expect(byOwner.total).toBeGreaterThan(0);
    expect(upToSetUp.items.every((e) => e.actor === null)).toBe(true);
    expect(upToSetUp.total + afterSetUp.total).toBe(all.total);
    expect(afterSetUp.items.some((e) => e.actor === null)).toBe(false);
  });

  it('is only for those allowed to read it', async () => {
    const response = await api(manager).get('/audit-log');

    // The manager was deactivated above, so they are signed out or forbidden.
    expect([401, 403]).toContain(response.statusCode);
    expect((await api(owner).get('/audit-log?table=sessions')).statusCode).toBe(400);
  });
});
