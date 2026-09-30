import { migrateDatabase, schema } from '@paint/db';
import { SYSTEM_ROLES } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  addMember,
  bearer,
  startTestApp,
  uniquePhone,
  type TestApp,
} from '../test-support/test-app.js';

interface Grant {
  token: string;
  organizationId: string;
}
interface Store {
  id: string;
  code: string;
  name: string;
}

let database: TestDatabase;
let t: TestApp;
let owner: Grant;
let hyderabad: Store;
let pune: Store;

async function signup(name: string): Promise<Grant> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: name,
      fullName: 'Owner',
      phone: uniquePhone(),
      password: 'Rangoli@2026',
    },
  });
  return response.json<Grant>();
}

async function loginAs(phone: string): Promise<string> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier: phone, password: 'Staff@2026' },
  });
  return response.json<Grant>().token;
}

const createStore = (token: string, payload: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url: '/stores', headers: bearer(token), payload });

const listStores = (token: string) =>
  t.app.inject({ method: 'GET', url: '/stores', headers: bearer(token) });

const getStore = (token: string, id: string) =>
  t.app.inject({ method: 'GET', url: `/stores/${id}`, headers: bearer(token) });

/** Adds a team member with a password and returns their session token. */
async function staff(
  roleKey: string,
  options: { storeIds?: string[]; organizationId?: string } = {},
): Promise<string> {
  const phone = uniquePhone();
  await addMember(t.connection, {
    organizationId: options.organizationId ?? owner.organizationId,
    roleKey,
    phone,
    password: 'Staff@2026',
    storeIds: options.storeIds ?? [],
  });
  return loginAs(phone);
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  owner = await signup('ABC Paints');
  hyderabad = (await createStore(owner.token, { name: 'Hyderabad', code: 'hyd' })).json<Store>();
  pune = (
    await createStore(owner.token, {
      name: 'Pune Godown',
      code: 'PUN',
      type: 'godown',
      city: 'Pune',
      state: 'Maharashtra',
      gstin: '27aapfu0939f1zv',
    })
  ).json<Store>();
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('owner', () => {
  it('creates stores, with codes and GSTIN stored uppercase', async () => {
    const response = await createStore(owner.token, {
      name: 'Secunderabad',
      code: 'sec-1',
      gstin: '36aabcu9603r1zo',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: expect.any(String),
      name: 'Secunderabad',
      code: 'SEC-1',
      type: 'store',
      city: null,
      state: null,
      gstin: '36AABCU9603R1ZO',
      isActive: true,
    });
  });

  it('sees every store, ordered by code', async () => {
    const codes = (await listStores(owner.token)).json<Store[]>().map((s) => s.code);

    expect(codes).toEqual(['HYD', 'PUN', 'SEC-1']);
  });

  it('opens any store by id', async () => {
    const response = await getStore(owner.token, pune.id);

    expect(response.statusCode).toBe(200);
    expect(response.json<Store>().name).toBe('Pune Godown');
  });

  it('cannot reuse a store code', async () => {
    const response = await createStore(owner.token, { name: 'Another Hyderabad', code: 'HYD' });

    expect(response.statusCode).toBe(409);
  });

  it.each([
    [{ code: 'X1' }, 'name'],
    [{ name: 'No code' }, 'code'],
    [{ name: 'Bad code', code: 'has space' }, 'code'],
    [{ name: 'Bad GSTIN', code: 'BG', gstin: '12345' }, 'gstin'],
    [{ name: 'Bad type', code: 'BT', type: 'warehouse' }, 'type'],
  ])('answers 400 for %o', async (payload, field) => {
    const response = await createStore(owner.token, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ issues: { path: string }[] }>().issues.map((i) => i.path)).toContain(
      field,
    );
  });

  it('answers 400 for a malformed id and 404 for an unknown one', async () => {
    expect((await getStore(owner.token, 'not-a-uuid')).statusCode).toBe(400);
    expect((await getStore(owner.token, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(
      404,
    );
  });
});

describe('Branch Manager of Hyderabad', () => {
  let token: string;

  beforeAll(async () => {
    token = await staff('branch_manager', { storeIds: [hyderabad.id] });
  });

  it('sees only Hyderabad', async () => {
    const codes = (await listStores(token)).json<Store[]>().map((s) => s.code);

    expect(codes).toEqual(['HYD']);
  });

  it('opens Hyderabad', async () => {
    expect((await getStore(token, hyderabad.id)).statusCode).toBe(200);
  });

  it('gets 404 for Pune, as if it did not exist', async () => {
    const response = await getStore(token, pune.id);

    expect(response.statusCode).toBe(404);
    expect(response.json<{ message: string }>().message).toBe('Store not found');
  });

  it('cannot create stores', async () => {
    const response = await createStore(token, { name: 'Kukatpally', code: 'KKP' });

    expect(response.statusCode).toBe(403);
  });

  it('sees their store access in their profile', async () => {
    const profile = await t.app.inject({ method: 'GET', url: '/auth/me', headers: bearer(token) });

    expect(profile.json()).toMatchObject({
      role: { key: 'branch_manager' },
      allStores: false,
      storeIds: [hyderabad.id],
      permissions: [
        ...(SYSTEM_ROLES.find((role) => role.key === 'branch_manager')?.permissions ?? []),
      ].sort(),
    });
  });
});

describe('a member with no store assigned yet', () => {
  it('sees an empty list rather than every store', async () => {
    const token = await staff('store_employee');

    const response = await listStores(token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});

describe('a custom role that can manage stores but not all of them', () => {
  it('can see the store it creates', async () => {
    const [role] = await t.connection.db
      .insert(schema.roles)
      .values({ organizationId: owner.organizationId, key: 'regional_lead', name: 'Regional Lead' })
      .returning({ id: schema.roles.id });
    await t.connection.db.insert(schema.rolePermissions).values(
      (['stores:read', 'stores:manage'] as const).map((permission) => ({
        organizationId: owner.organizationId,
        roleId: role?.id ?? '',
        permission,
      })),
    );
    const token = await staff('regional_lead');

    const created = await createStore(token, { name: 'Warangal', code: 'WGL' });
    const visible = (await listStores(token)).json<Store[]>().map((s) => s.code);

    expect(created.statusCode).toBe(201);
    expect(visible).toEqual(['WGL']);
  });
});

describe('another business', () => {
  it("cannot see or open ABC Paints' stores, even as its own owner", async () => {
    const rival = await signup('XYZ Paints');

    expect((await listStores(rival.token)).json()).toEqual([]);
    expect((await getStore(rival.token, hyderabad.id)).statusCode).toBe(404);
  });
});

describe('without signing in', () => {
  it('answers 401', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/stores' })).statusCode).toBe(401);
  });
});
