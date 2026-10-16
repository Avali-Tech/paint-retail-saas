import { migrateDatabase, schema } from '@paint/db';
import { SYSTEM_ROLES } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
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
      memberId: expect.any(String),
      role: { key: 'branch_manager' },
      allStores: false,
      storeIds: [hyderabad.id],
      permissions: [
        ...(SYSTEM_ROLES.find((role) => role.key === 'branch_manager')?.permissions ?? []),
      ].sort(),
    });
  });
});

describe('store directory', () => {
  const directory = (token: string) =>
    t.app.inject({ method: 'GET', url: '/stores/directory', headers: bearer(token) });

  it('lists every open store with only id, code and name, even to single-store staff', async () => {
    const token = await staff('store_employee', { storeIds: [hyderabad.id] });
    const [closed] = await t.connection.db
      .insert(schema.stores)
      .values({
        organizationId: owner.organizationId,
        name: 'Closed',
        code: 'AAA-CLOSED',
        isActive: false,
      })
      .returning({ id: schema.stores.id });

    const response = await directory(token);

    expect(response.statusCode).toBe(200);
    const entries = response.json<Store[]>();
    expect(entries[0]).toEqual({ id: hyderabad.id, code: 'HYD', name: 'Hyderabad' });
    expect(entries.map((s) => s.code)).toEqual(expect.arrayContaining(['HYD', 'PUN']));
    expect(entries.map((s) => s.id)).not.toContain(closed?.id);
    expect(entries.map((s) => s.code)).toEqual([...entries.map((s) => s.code)].sort());
  });

  it("never shows another business's stores", async () => {
    const rival = await signup('Directory Rival');

    expect((await directory(rival.token)).json()).toEqual([]);
  });

  it('needs stores:read', async () => {
    const [role] = await t.connection.db
      .insert(schema.roles)
      .values({ organizationId: owner.organizationId, key: 'no_stores', name: 'No stores' })
      .returning({ id: schema.roles.id });
    await t.connection.db.insert(schema.rolePermissions).values({
      organizationId: owner.organizationId,
      roleId: role?.id ?? '',
      permission: 'parties:read',
    });
    const token = await staff('no_stores');

    expect((await directory(token)).statusCode).toBe(403);
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

describe('creating a store with its GST registration (PO-102)', () => {
  const TELANGANA_GSTIN = '36AABCS1429B1ZV';
  const registrations = (token: string) =>
    t.app.inject({ method: 'GET', url: '/gst-registrations', headers: bearer(token) });

  it('saves the store and its registration together', async () => {
    const business = await signup('Registered Paints');
    await t.app.inject({
      method: 'PUT',
      url: '/gst-registrations/business',
      headers: bearer(business.token),
      payload: { legalName: 'Registered Paints LLP' },
    });

    const response = await createStore(business.token, {
      name: 'Kukatpally',
      code: 'kkp',
      registration: {
        registrationType: 'regular',
        stateCode: '36',
        gstin: TELANGANA_GSTIN.toLowerCase(),
        addressLine: 'Plot 4, KPHB',
        city: 'Hyderabad',
        pincode: '500072',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: expect.any(String),
      name: 'Kukatpally',
      code: 'KKP',
      type: 'store',
      city: 'Hyderabad',
      state: 'Telangana',
      gstin: TELANGANA_GSTIN,
      isActive: true,
    });
    expect((await registrations(business.token)).json()).toMatchObject({
      pan: 'AABCS1429B',
      stores: [
        {
          code: 'KKP',
          registrationType: 'regular',
          stateCode: '36',
          legalName: 'Registered Paints LLP',
          addressLine: 'Plot 4, KPHB',
          pincode: '500072',
        },
      ],
    });
  });

  it('saves nothing when the registration is refused', async () => {
    const business = await signup('No Legal Name Paints');

    const response = await createStore(business.token, {
      name: 'Kukatpally',
      code: 'KKP',
      registration: { registrationType: 'regular', stateCode: '36', gstin: TELANGANA_GSTIN },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ issues: { path: string }[] }>().issues[0]?.path).toBe('legalName');
    expect((await listStores(business.token)).json()).toEqual([]);
  });

  it.each([
    [
      { registration: { registrationType: 'regular', stateCode: '27', gstin: TELANGANA_GSTIN } },
      'registration.gstin',
    ],
    [
      {
        gstin: TELANGANA_GSTIN,
        registration: { registrationType: 'unregistered', stateCode: '36' },
      },
      'registration',
    ],
  ])('answers 400 for %o', async (payload, field) => {
    const response = await createStore(owner.token, { name: 'Bad', code: 'BAD', ...payload });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ issues: { path: string }[] }>().issues.map((i) => i.path)).toContain(
      field,
    );
  });

  it('needs tax:manage to register, as well as stores:manage', async () => {
    const [role] = await t.connection.db
      .insert(schema.roles)
      .values({ organizationId: owner.organizationId, key: 'store_opener', name: 'Store opener' })
      .returning({ id: schema.roles.id });
    await t.connection.db.insert(schema.rolePermissions).values(
      (['stores:read', 'stores:manage'] as const).map((permission) => ({
        organizationId: owner.organizationId,
        roleId: role?.id ?? '',
        permission,
      })),
    );
    const token = await staff('store_opener');

    const response = await createStore(token, {
      name: 'Nizamabad',
      code: 'NZB',
      registration: { registrationType: 'unregistered', stateCode: '36' },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('editing, closing and reopening a store (PO-102)', () => {
  let business: Grant;
  let first: Store;
  let second: Store;

  const update = (token: string, id: string, payload: Record<string, unknown>) =>
    t.app.inject({ method: 'PATCH', url: `/stores/${id}`, headers: bearer(token), payload });

  beforeAll(async () => {
    business = await signup('Edit Paints');
    first = (await createStore(business.token, { name: 'Main', code: 'MAIN' })).json<Store>();
    second = (await createStore(business.token, { name: 'Godown', code: 'GDN' })).json<Store>();
  });

  it('renames a store and changes its kind; the code stays', async () => {
    const response = await update(business.token, second.id, {
      name: 'Back Godown',
      type: 'godown',
      code: 'NEW',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: second.id,
      name: 'Back Godown',
      code: 'GDN',
      type: 'godown',
      isActive: true,
    });
  });

  it('closes a store and reopens it', async () => {
    const closed = await update(business.token, second.id, { isActive: false });
    expect(closed.json()).toMatchObject({ isActive: false });
    const directory = await t.app.inject({
      method: 'GET',
      url: '/stores/directory',
      headers: bearer(business.token),
    });
    expect(directory.json<Store[]>().map((store) => store.code)).toEqual(['MAIN']);

    const reopened = await update(business.token, second.id, { isActive: true });
    expect(reopened.json()).toMatchObject({ isActive: true });
    // Saying what already is changes nothing.
    expect((await update(business.token, second.id, { isActive: true })).statusCode).toBe(200);
  });

  it('keeps at least one store open', async () => {
    expect((await update(business.token, second.id, { isActive: false })).statusCode).toBe(200);
    // Closing a closed store again is fine.
    expect((await update(business.token, second.id, { isActive: false })).statusCode).toBe(200);

    const response = await update(business.token, first.id, { isActive: false });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toBe('Keep at least one store open');
    expect((await update(business.token, second.id, { isActive: true })).statusCode).toBe(200);
  });

  it('counts a reopened store against the plan', async () => {
    const small = await signup('Plan Paints');
    await t.connection.db
      .update(schema.organizations)
      .set({ plan: 'trial' })
      .where(eq(schema.organizations.id, small.organizationId));
    const created: Store[] = [];
    for (const code of ['P1', 'P2', 'P3', 'P4', 'P5']) {
      created.push((await createStore(small.token, { name: code, code })).json<Store>());
    }
    const closing = String(created[0]?.id);
    expect((await update(small.token, closing, { isActive: false })).statusCode).toBe(200);
    expect((await createStore(small.token, { name: 'P6', code: 'P6' })).statusCode).toBe(201);

    const response = await update(small.token, closing, { isActive: true });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ message: string }>().message).toBe(
      'The Trial plan allows 5 active stores. The owner can upgrade the plan under Billing.',
    );
  });

  it('answers 400 for nothing to change or a bad value, and 404 for a store out of reach', async () => {
    expect((await update(business.token, first.id, {})).statusCode).toBe(400);
    expect((await update(business.token, first.id, { name: 'X' })).statusCode).toBe(400);
    expect(
      (await update(business.token, '00000000-0000-4000-8000-000000000000', { name: 'Nope' }))
        .statusCode,
    ).toBe(404);
    expect((await update(owner.token, first.id, { name: 'Not yours' })).statusCode).toBe(404);
  });

  it('is only for those who manage stores, at stores they can access', async () => {
    const manager = await staff('branch_manager', {
      organizationId: business.organizationId,
      storeIds: [first.id],
    });
    expect((await update(manager, first.id, { name: 'Renamed' })).statusCode).toBe(403);
    const lead = await staff('regional_lead');
    expect((await update(lead, hyderabad.id, { name: 'Renamed' })).statusCode).toBe(404);
  });
});
