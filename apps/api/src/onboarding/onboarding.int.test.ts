import { migrateDatabase } from '@paint/db';
import { toCsv } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

interface Onboarding {
  steps: { key: string; title: string; done: boolean; count: number; importKind: string | null }[];
  completed: number;
  total: number;
}

let database: TestDatabase;
let t: TestApp;

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  put: (url: string, payload: object) =>
    t.app.inject({ method: 'PUT', url, headers: bearer(token), payload }),
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

const progress = async (token: string) => (await api(token).get('/onboarding')).json<Onboarding>();
const done = (onboarding: Onboarding) =>
  Object.fromEntries(onboarding.steps.map((step) => [step.key, step.done]));

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('onboarding checklist', () => {
  it('starts with nothing done, in the order to do it', async () => {
    const owner = await signup('Fresh Paints');

    const onboarding = await progress(owner);

    expect(onboarding).toMatchObject({ completed: 0, total: 7 });
    expect(onboarding.steps.map((step) => [step.key, step.count, step.importKind])).toEqual([
      ['stores', 0, null],
      ['team', 1, null],
      ['products', 0, 'products'],
      ['suppliers', 0, 'parties'],
      ['customers', 0, 'parties'],
      ['opening_stock', 0, 'opening-stock'],
      ['reorder_rules', 0, null],
    ]);
    expect(onboarding.steps[0]?.title).toBe('Add your stores');
    expect((await t.app.inject({ method: 'GET', url: '/onboarding' })).statusCode).toBe(401);
  });

  it('ticks off each step as the business is set up, counting only its own records', async () => {
    const owner = await signup('Setup Paints');
    const other = await signup('Other Paints');
    const store = (await api(owner).post('/stores', { name: 'Hyderabad', code: 'HYD' })).json<{
      id: string;
    }>().id;
    const roles = (await api(owner).get('/roles')).json<{ id: string; key: string }[]>();
    await api(owner).post('/members', {
      fullName: 'Cashier',
      phone: uniquePhone(),
      password: 'Staff@2026',
      roleId: roles.find((role) => role.key === 'store_employee')?.id,
      storeIds: [store],
    });
    await api(owner).post('/imports/products', {
      csv: toCsv([
        ['brand', 'product', 'type', 'hsn_code', 'gst_percent', 'sku', 'pack_size', 'unit'],
        ['Asian Paints', 'Apex', 'exterior_paint', '3209', '18', 'APX-1L', '1', 'l'],
      ]),
    });
    await api(owner).post('/imports/parties', {
      csv: toCsv([
        ['name', 'roles', 'phone'],
        ['Depot', 'supplier', uniquePhone()],
        ['Painter', 'painter;customer', uniquePhone()],
      ]),
    });
    const halfway = await progress(owner);
    await api(owner).post('/imports/opening-stock', {
      csv: toCsv([
        ['store', 'sku', 'quantity'],
        ['HYD', 'APX-1L', '10'],
      ]),
    });
    const variantId = (await api(owner).get('/products/lookup?code=APX-1L')).json<{
      variant: { id: string };
    }>().variant.id;
    await api(owner).put('/reorder-rules', {
      rules: [{ storeId: store, variantId, minQuantity: 2, reorderLevel: 4, maxQuantity: 12 }],
    });

    expect(done(halfway)).toEqual({
      stores: true,
      team: true,
      products: true,
      suppliers: true,
      customers: true,
      opening_stock: false,
      reorder_rules: false,
    });
    expect(halfway.steps.find((step) => step.key === 'customers')?.count).toBe(1);
    expect(await progress(owner)).toMatchObject({ completed: 7, total: 7 });
    expect((await progress(other)).completed).toBe(0);
  });
});
