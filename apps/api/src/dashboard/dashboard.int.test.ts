import { migrateDatabase, schema } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { seedBusiness, type Business } from '../test-support/business.js';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import type { Dashboard } from './dashboard.service.js';

let database: TestDatabase;
let t: TestApp;
let business: Business;

const dashboard = async (token: string, query = '') => {
  const response = await t.app.inject({
    method: 'GET',
    url: `/dashboard${query}`,
    headers: bearer(token),
  });
  return response;
};

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  business = await seedBusiness(t);
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('owner dashboard', () => {
  it('shows every store’s position on one screen', async () => {
    const view = (await dashboard(business.owner)).json<Dashboard>();

    expect(view.stores.map((s) => s.store.code)).toEqual(['HYD', 'PUN', 'SEC']);
    const [hyd, pune, sec] = view.stores;
    expect(hyd).toMatchObject({
      // 13 × APX-1L (one free, so averaging ₹92.31) and 3 × APX-4L at ₹400.
      stock: { valuePaise: 240_003, units: 16, skus: 2, uncostedSkus: 0 },
      lowStock: { outOfStock: 1, belowMinimum: 1, reorder: 0 },
      transfers: { awaitingApproval: 0, toDispatch: 0, incoming: 1 },
      purchaseOrders: { open: 2, dueValuePaise: 430_000 },
    });
    expect(pune).toMatchObject({
      stock: { valuePaise: 187_000, units: 22, skus: 2, uncostedSkus: 1 },
      lowStock: { outOfStock: 0, belowMinimum: 0, reorder: 0 },
      transfers: { awaitingApproval: 2, toDispatch: 1, incoming: 0 },
      purchaseOrders: { open: 0, dueValuePaise: 0 },
    });
    expect(sec).toMatchObject({
      stock: { valuePaise: 0, units: 0, skus: 0 },
      transfers: { awaitingApproval: 0, toDispatch: 0, incoming: 0 },
    });
    expect(view.totals).toEqual({
      stock: { valuePaise: 427_003, units: 38, skus: 4, uncostedSkus: 1 },
      lowStock: { outOfStock: 1, belowMinimum: 1, reorder: 0 },
      transfers: { awaitingApproval: 2, toDispatch: 1, incoming: 1 },
      purchaseOrders: { open: 2, dueValuePaise: 430_000 },
    });
  });

  it('adds the sales pipeline, projects and follow-ups', async () => {
    const view = (await dashboard(business.owner)).json<Dashboard>();

    expect(view.leads?.filter((s) => s.count > 0)).toEqual([
      { stage: 'new', count: 1, valuePaise: 100_000 },
      { stage: 'qualified', count: 1, valuePaise: 0 },
      { stage: 'lost', count: 1, valuePaise: 0 },
    ]);
    expect(view.opportunities?.[0]).toEqual({
      stage: 'discovery',
      count: 1,
      valuePaise: 500_000,
      weightedValuePaise: 100_000,
    });
    expect(view.opportunities?.find((s) => s.stage === 'won')).toEqual({
      stage: 'won',
      count: 0,
      valuePaise: 0,
      weightedValuePaise: 0,
    });
    expect(view.projects?.filter((s) => s.count > 0)).toEqual([
      { stage: 'identified', count: 1, valuePaise: 900_000 },
      { stage: 'survey', count: 1, valuePaise: 0 },
    ]);
    expect(view.followUps).toEqual({ overdue: 1, today: 1 });
    expect(Date.now() - Date.parse(view.generatedAt)).toBeLessThan(60_000);
  });

  it('shows a store manager only their stores, and one store on request', async () => {
    const own = (await dashboard(business.manager)).json<Dashboard>();
    const one = (
      await dashboard(business.owner, `?storeId=${business.stores.pune}`)
    ).json<Dashboard>();

    expect(own.stores.map((s) => s.store.code)).toEqual(['HYD']);
    expect(own.leads?.find((s) => s.stage === 'qualified')?.count).toBe(0);
    expect(own.followUps).toEqual({ overdue: 1, today: 1 });
    expect(one.stores.map((s) => s.store.code)).toEqual(['PUN']);
    expect(one.totals.purchaseOrders).toEqual({ open: 0, dueValuePaise: 0 });
    expect((await dashboard(business.manager, `?storeId=${business.stores.pune}`)).statusCode).toBe(
      404,
    );
  });

  it('leaves out sections the member may not see', async () => {
    const view = (await dashboard(business.cashier)).json<Dashboard>();

    expect(view.stores[0]).toMatchObject({ purchaseOrders: null, stock: { skus: 2 } });
    expect(view.totals.purchaseOrders).toBeNull();
    expect(view).toMatchObject({ leads: null, opportunities: null, projects: null });
  });

  it('shows just the stores to someone who may see nothing else', async () => {
    const [{ organizationId } = { organizationId: '' }] = await t.connection.db
      .select({ organizationId: schema.stores.organizationId })
      .from(schema.stores);
    const [role] = await t.connection.db
      .insert(schema.roles)
      .values({ organizationId, key: 'viewer', name: 'Viewer' })
      .returning({ id: schema.roles.id });
    await t.connection.db
      .insert(schema.rolePermissions)
      .values({ organizationId, roleId: String(role?.id), permission: 'stores:read' });
    const phone = uniquePhone();
    await t.app.inject({
      method: 'POST',
      url: '/members',
      headers: bearer(business.owner),
      payload: {
        fullName: 'Viewer',
        phone,
        password: 'Staff@2026',
        roleId: role?.id,
        storeIds: [business.stores.hyd],
      },
    });
    const viewer = (
      await t.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { identifier: phone, password: 'Staff@2026' },
      })
    ).json<{ token: string }>().token;

    const view = (await dashboard(viewer)).json<Dashboard>();

    expect(view.stores).toEqual([
      {
        store: expect.objectContaining({ code: 'HYD' }),
        stock: null,
        lowStock: null,
        transfers: null,
        purchaseOrders: null,
      },
    ]);
    expect(view.totals).toEqual({
      stock: null,
      lowStock: null,
      transfers: null,
      purchaseOrders: null,
    });
  });
});
