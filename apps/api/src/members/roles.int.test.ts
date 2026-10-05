import { migrateDatabase } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import { finishSignIn } from '../test-support/two-factor.js';

interface Role {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
  memberCount: number;
}

const PASSWORD = 'Staff@2026';

let database: TestDatabase;
let t: TestApp;
let owner: string;
let hyd: string;

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  patch: (url: string, payload: object) =>
    t.app.inject({ method: 'PATCH', url, headers: bearer(token), payload }),
});
const message = (reply: Awaited<ReturnType<TestApp['app']['inject']>>) =>
  reply.json<{ message: string }>().message;

async function signup(name: string): Promise<string> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: name,
      fullName: 'Owner',
      phone: uniquePhone(),
      password: PASSWORD,
    },
  });
  return response.json<{ token: string }>().token;
}

const roles = async (token = owner) => (await api(token).get('/roles')).json<Role[]>();
const roleByKey = async (key: string) => (await roles()).find((role) => role.key === key);

/** Adds a member with this role at Hyderabad and signs them in. */
async function hire(roleId: string): Promise<string> {
  const phone = uniquePhone();
  const added = await api(owner).post('/members', {
    fullName: `Staff ${phone.slice(-4)}`,
    phone,
    password: PASSWORD,
    roleId,
    storeIds: [hyd],
  });
  expect(added.statusCode).toBe(201);
  const login = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier: phone, password: PASSWORD },
  });
  return (await finishSignIn<{ token: string }>(t, login, phone)).token;
}

async function createRole(name: string, permissions: string[], token = owner): Promise<Role> {
  const response = await api(token).post('/roles', { name, permissions });
  expect(response.statusCode).toBe(201);
  return response.json<Role>();
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  owner = await signup('ABC Paints');
  hyd = (await api(owner).post('/stores', { name: 'Hyderabad', code: 'HYD' })).json<{
    id: string;
  }>().id;
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('GET /roles', () => {
  it('lists system roles with how many active members hold each', async () => {
    const before = await roleByKey('store_employee');
    await hire(String(before?.id));

    const after = await roleByKey('store_employee');

    expect(after).toMatchObject({ isSystem: true, memberCount: Number(before?.memberCount) + 1 });
    expect((await roleByKey('owner'))?.memberCount).toBe(1);
  });
});

describe('POST /roles', () => {
  it('creates a custom role with its permissions, de-duplicated and sorted', async () => {
    const response = await api(owner).post('/roles', {
      name: '  Cashier ',
      permissions: ['stores:read', 'parties:read', 'stores:read'],
    });

    expect(response.statusCode).toBe(201);
    const role = response.json<Role>();
    expect(role).toEqual({
      id: expect.any(String),
      key: expect.stringMatching(/^custom_[0-9a-f]{8}$/),
      name: 'Cashier',
      isSystem: false,
      permissions: ['parties:read', 'stores:read'],
      memberCount: 0,
    });
    expect((await roles()).map((r) => r.id)).toContain(role.id);
  });

  it('refuses a name already used, ignoring case', async () => {
    await createRole('Delivery', ['stores:read']);

    const again = await api(owner).post('/roles', {
      name: 'DELIVERY',
      permissions: ['stores:read'],
    });
    const system = await api(owner).post('/roles', { name: 'owner', permissions: ['stores:read'] });

    expect([again.statusCode, message(again)]).toEqual([
      409,
      'A role with this name already exists',
    ]);
    expect(system.statusCode).toBe(409);
  });

  it.each([
    [{ name: 'No permissions', permissions: [] }, 'permissions'],
    [{ name: 'Made up', permissions: ['stores:fly'] }, 'permissions.0'],
    [{ name: 'X', permissions: ['stores:read'] }, 'name'],
    [{ permissions: ['stores:read'] }, 'name'],
  ])('answers 400 for %o', async (payload, field) => {
    const response = await api(owner).post('/roles', payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ issues: { path: string }[] }>().issues.map((i) => i.path)).toContain(
      field,
    );
  });

  it('needs roles:manage', async () => {
    const manager = await hire(String((await roleByKey('branch_manager'))?.id));

    const response = await api(manager).post('/roles', {
      name: 'Sneaky',
      permissions: ['stores:read'],
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('PATCH /roles/:id', () => {
  it('renames and replaces permissions; members get them on their next request; audited exactly', async () => {
    const role = await createRole('Counter', ['stores:read', 'parties:read']);
    const member = await hire(role.id);

    const response = await api(owner).patch(`/roles/${role.id}`, {
      name: 'Counter Staff',
      permissions: ['stores:read', 'catalog:read'],
    });
    const profile = (await api(member).get('/auth/me')).json<{ permissions: string[] }>();
    const audit = (
      await api(owner).get(`/audit-log?table=role_permissions&recordId=${role.id}&limit=10`)
    ).json<{ items: { action: string; changes: { newText: string; oldText: string }[] }[] }>();

    expect(response.statusCode).toBe(200);
    expect(response.json<Role>()).toMatchObject({
      name: 'Counter Staff',
      permissions: ['catalog:read', 'stores:read'],
      memberCount: 1,
    });
    expect(profile.permissions).toEqual(['catalog:read', 'stores:read']);
    // Only what changed: one permission added, one removed; stores:read untouched.
    expect(
      audit.items
        .slice(0, 2)
        .map((entry) => [entry.action, entry.changes[0]?.oldText ?? entry.changes[0]?.newText])
        .sort(),
    ).toEqual([
      ['delete', 'parties:read'],
      ['insert', 'catalog:read'],
    ]);
    expect(audit.items).toHaveLength(4);
  });

  it('keeps its name in another case, and refuses another role’s name', async () => {
    const role = await createRole('Painter Desk', ['stores:read']);
    await createRole('Billing', ['stores:read']);

    const recased = await api(owner).patch(`/roles/${role.id}`, { name: 'painter desk' });
    const taken = await api(owner).patch(`/roles/${role.id}`, { name: 'billing' });
    const permissionsOnly = await api(owner).patch(`/roles/${role.id}`, {
      permissions: ['catalog:read'],
    });

    expect(recased.json<Role>().name).toBe('painter desk');
    expect(taken.statusCode).toBe(409);
    expect(permissionsOnly.json<Role>()).toMatchObject({
      name: 'painter desk',
      permissions: ['catalog:read'],
    });
  });

  it('answers 400 for an empty change or a malformed id, and 404 for an unknown role', async () => {
    const role = await createRole('Empty Change', ['stores:read']);

    expect((await api(owner).patch(`/roles/${role.id}`, {})).statusCode).toBe(400);
    expect((await api(owner).patch('/roles/nope', { name: 'Nope' })).statusCode).toBe(400);
    expect(
      (await api(owner).patch('/roles/00000000-0000-4000-8000-000000000000', { name: 'Ghost' }))
        .statusCode,
    ).toBe(404);
  });

  it("cannot reach another business's roles", async () => {
    const role = await createRole('Private', ['stores:read']);
    const rival = await signup('XYZ Paints');

    expect((await api(rival).patch(`/roles/${role.id}`, { name: 'Mine' })).statusCode).toBe(404);
    expect((await roles(rival)).map((r) => r.id)).not.toContain(role.id);
  });
});

describe('no one can hand out more than they hold', () => {
  it('a role manager with few permissions', async () => {
    const leadRole = await createRole('Team Lead', ['roles:manage', 'members:read', 'stores:read']);
    const lead = await hire(leadRole.id);
    const broad = await createRole('Broad', ['stores:read', 'parties:read']);
    const ownerRole = await roleByKey('owner');

    const escalate = await api(lead).post('/roles', {
      name: 'Escalated',
      permissions: ['inventory:manage'],
    });
    const modest = await createRole('Modest', ['stores:read'], lead);
    const widen = await api(lead).patch(`/roles/${modest.id}`, {
      permissions: ['stores:read', 'catalog:read'],
    });
    const rename = await api(lead).patch(`/roles/${modest.id}`, { name: 'Modest Too' });
    const system = await api(lead).patch(`/roles/${String(ownerRole?.id)}`, { name: 'Boss' });
    const own = await api(lead).patch(`/roles/${leadRole.id}`, { name: 'Head' });
    const wider = await api(lead).patch(`/roles/${broad.id}`, { name: 'Narrow' });

    expect([escalate.statusCode, message(escalate)]).toEqual([
      403,
      'You cannot give permissions you do not have',
    ]);
    expect([widen.statusCode, message(widen)]).toEqual([
      403,
      'You cannot give permissions you do not have',
    ]);
    expect(rename.statusCode).toBe(200);
    expect([system.statusCode, message(system)]).toEqual([403, 'System roles cannot be changed']);
    expect([own.statusCode, message(own)]).toEqual([403, 'You cannot change your own role']);
    expect([wider.statusCode, message(wider)]).toEqual([
      403,
      'This role has permissions you are not allowed to manage',
    ]);
  });
});
