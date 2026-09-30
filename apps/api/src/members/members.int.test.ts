import { migrateDatabase, schema } from '@paint/db';
import { PERMISSIONS, SYSTEM_ROLES } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

interface Grant {
  token: string;
  organizationId: string;
}
interface Member {
  id: string;
  user: { id: string; fullName: string; phone: string | null; email: string | null };
  role: { id: string; key: string; name: string };
  allStores: boolean;
  storeIds: string[];
  isActive: boolean;
}
interface Role {
  id: string;
  key: string;
  permissions: string[];
}

let database: TestDatabase;
let t: TestApp;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

const PASSWORD = 'Staff@2026';

async function signup(name: string) {
  const phone = uniquePhone();
  const response = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { organizationName: name, fullName: `${name} Owner`, phone, password: PASSWORD },
  });
  return { ...response.json<Grant>(), phone };
}

async function login(identifier: string, organizationId?: string): Promise<string> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier, password: PASSWORD, organizationId },
  });
  return response.json<Grant>().token;
}

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  patch: (url: string, payload: object) =>
    t.app.inject({ method: 'PATCH', url, headers: bearer(token), payload }),
});

// A fresh business for each test keeps tests independent.
let owner: Awaited<ReturnType<typeof signup>>;
let roleId: Record<string, string>;
let hyd: string;
let pune: string;

async function store(code: string): Promise<string> {
  return (await api(owner.token).post('/stores', { name: code, code })).json<{ id: string }>().id;
}

/** Adds a member through the API as the owner and returns them with a session token. */
async function hire(role: string, storeIds: string[], extra: object = {}) {
  const phone = uniquePhone();
  const response = await api(owner.token).post('/members', {
    fullName: `${role} ${phone.slice(-4)}`,
    phone,
    password: PASSWORD,
    roleId: roleId[role],
    storeIds,
    ...extra,
  });
  expect(response.statusCode).toBe(201);
  return { member: response.json<Member>(), phone, token: await login(phone) };
}

/** A custom role that can manage members, limited to the stores it is given. */
async function customManagerRole(permissions: string[]): Promise<string> {
  const [role] = await t.connection.db
    .insert(schema.roles)
    .values({ organizationId: owner.organizationId, key: `lead_${uniquePhone()}`, name: 'Lead' })
    .returning({ id: schema.roles.id, key: schema.roles.key });
  await t.connection.db.insert(schema.rolePermissions).values(
    permissions.map((permission) => ({
      organizationId: owner.organizationId,
      roleId: role?.id ?? '',
      permission,
    })),
  );
  roleId[role?.key ?? ''] = role?.id ?? '';
  return role?.key ?? '';
}

beforeEach(async () => {
  owner = await signup('ABC Paints');
  const roles = (await api(owner.token).get('/roles')).json<Role[]>();
  roleId = Object.fromEntries(roles.map((role) => [role.key, role.id]));
  hyd = await store('HYD');
  pune = await store('PUN');
});

describe('GET /roles', () => {
  it('lists the business’s roles with their permissions', async () => {
    const roles = (await api(owner.token).get('/roles')).json<Role[]>();

    expect(roles.map((role) => role.key).sort()).toEqual(
      [
        'branch_manager',
        'crm_executive',
        'inventory_manager',
        'org_admin',
        'owner',
        'sales_executive',
        'store_employee',
      ].sort(),
    );
    expect(roles.find((role) => role.key === 'owner')?.permissions).toEqual(
      [...PERMISSIONS].sort(),
    );
  });

  it('is open to branch managers but not to store employees', async () => {
    const manager = await hire('branch_manager', [hyd]);
    const employee = await hire('store_employee', [hyd]);

    expect((await api(manager.token).get('/roles')).statusCode).toBe(200);
    expect((await api(employee.token).get('/roles')).statusCode).toBe(403);
  });
});

describe('POST /members', () => {
  it('adds a new person who can then sign in with their role and stores', async () => {
    const { member, token } = await hire('branch_manager', [hyd]);

    expect(member).toMatchObject({
      role: { key: 'branch_manager' },
      allStores: false,
      storeIds: [hyd],
      isActive: true,
    });
    const profile = (await api(token).get('/auth/me')).json<{
      storeIds: string[];
      role: { key: string };
    }>();
    expect(profile.role.key).toBe('branch_manager');
    expect(profile.storeIds).toEqual([hyd]);
  });

  it('adds someone without a password, who signs in with an SMS code', async () => {
    const phone = uniquePhone();
    const response = await api(owner.token).post('/members', {
      fullName: 'Ravi Painter',
      phone: phone.slice(3),
      roleId: roleId.store_employee,
      storeIds: [hyd],
    });
    expect(response.statusCode).toBe(201);

    await t.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone } });
    const verify = await t.app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: t.sms.lastCodeFor(phone) },
    });

    expect(verify.statusCode).toBe(200);
  });

  it('links a person who already has an account at another business', async () => {
    const other = await signup('XYZ Paints');

    const response = await api(owner.token).post('/members', {
      fullName: 'Ignored Name',
      phone: other.phone,
      roleId: roleId.sales_executive,
      storeIds: [hyd],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<Member>().user.fullName).toBe('XYZ Paints Owner');
    const choice = await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { identifier: other.phone, password: PASSWORD },
    });
    expect(choice.statusCode).toBe(409);
  });

  it('refuses to set a password for someone who already has one', async () => {
    const other = await signup('XYZ Paints');

    const response = await api(owner.token).post('/members', {
      fullName: 'Someone',
      phone: other.phone,
      password: 'New@Password1',
      roleId: roleId.sales_executive,
    });

    expect(response.statusCode).toBe(409);
  });

  it('refuses to add someone twice', async () => {
    const { phone } = await hire('store_employee', [hyd]);

    const response = await api(owner.token).post('/members', {
      fullName: 'Again',
      phone,
      roleId: roleId.store_employee,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toMatch(/already a member/);
  });

  it('refuses a phone and an email that belong to two different people', async () => {
    const first = await signup('One Paints');
    await api(owner.token).post('/members', {
      fullName: 'Has Email',
      email: 'has.email@abc.in',
      roleId: roleId.store_employee,
    });

    const response = await api(owner.token).post('/members', {
      fullName: 'Mixed',
      phone: first.phone,
      email: 'has.email@abc.in',
      roleId: roleId.store_employee,
    });

    expect(response.statusCode).toBe(409);
  });

  it('adds by email alone', async () => {
    const response = await api(owner.token).post('/members', {
      fullName: 'Email Only',
      email: 'Email.Only@ABC.in',
      roleId: roleId.crm_executive,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<Member>().user.email).toBe('email.only@abc.in');
  });

  it("rejects another business's role or store as unknown", async () => {
    const other = await signup('XYZ Paints');
    const otherRoles = (await api(other.token).get('/roles')).json<Role[]>();
    const otherStore = (
      await api(other.token).post('/stores', { name: 'Theirs', code: 'THR' })
    ).json<{ id: string }>().id;

    const foreignRole = await api(owner.token).post('/members', {
      fullName: 'Foreign Role',
      phone: uniquePhone(),
      roleId: otherRoles[0]?.id,
    });
    const foreignStore = await api(owner.token).post('/members', {
      fullName: 'Foreign Store',
      phone: uniquePhone(),
      roleId: roleId.store_employee,
      storeIds: [otherStore],
    });

    expect(foreignRole.statusCode).toBe(400);
    expect(foreignRole.json<{ message: string }>().message).toBe('Unknown role');
    expect(foreignStore.statusCode).toBe(400);
    expect(foreignStore.json<{ message: string }>().message).toBe('Unknown store');
  });

  it.each([
    [{ roleId: undefined }, 'roleId'],
    [{ phone: undefined }, 'phone'],
    [{ fullName: 'A' }, 'fullName'],
    [{ storeIds: ['not-a-uuid'] }, 'storeIds.0'],
  ])('answers 400 for %o', async (overrides, field) => {
    const response = await api(owner.token).post('/members', {
      fullName: 'Valid Name',
      phone: uniquePhone(),
      roleId: roleId.store_employee,
      ...overrides,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ issues: { path: string }[] }>().issues.map((i) => i.path)).toContain(
      field,
    );
  });

  it('ignores duplicate store ids', async () => {
    const { member } = await hire('store_employee', [hyd, hyd]);

    expect(member.storeIds).toEqual([hyd]);
  });

  it('does not create the account when the request is refused', async () => {
    const admin = await hire('org_admin', [], { allStores: true });
    const phone = uniquePhone();

    const response = await api(admin.token).post('/members', {
      fullName: 'Would-be Owner',
      phone,
      roleId: roleId.owner,
    });

    expect(response.statusCode).toBe(403);
    const created = await t.connection.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.phone, phone));
    expect(created).toEqual([]);
  });
});

describe('no one can hand out more access than they have', () => {
  it('only owners can make owners', async () => {
    const admin = await hire('org_admin', [], { allStores: true });
    const phone = uniquePhone();

    const byAdmin = await api(admin.token).post('/members', {
      fullName: 'Co-owner',
      phone,
      roleId: roleId.owner,
      allStores: true,
    });
    const byOwner = await api(owner.token).post('/members', {
      fullName: 'Co-owner',
      phone,
      roleId: roleId.owner,
      allStores: true,
    });

    expect(byAdmin.statusCode).toBe(403);
    expect(byAdmin.json<{ message: string }>().message).toBe(
      'Only an owner can make someone an owner',
    );
    expect(byOwner.statusCode).toBe(201);
  });

  describe('a manager limited to Hyderabad', () => {
    let lead: Awaited<ReturnType<typeof hire>>;

    beforeEach(async () => {
      // Everything a Store Employee has, plus team management, limited to Hyderabad.
      const employee = SYSTEM_ROLES.find((role) => role.key === 'store_employee');
      const key = await customManagerRole([
        ...(employee?.permissions ?? []),
        'members:read',
        'members:manage',
      ]);
      lead = await hire(key, [hyd]);
    });

    it('can add staff to Hyderabad', async () => {
      const response = await api(lead.token).post('/members', {
        fullName: 'New Hire',
        phone: uniquePhone(),
        roleId: roleId.store_employee,
        storeIds: [hyd],
      });

      expect(response.statusCode).toBe(201);
    });

    interface EscalationCase {
      roleId: string;
      allStores?: boolean;
      storeIds?: ('HYD' | 'PUNE')[];
    }
    const escalations: [string, EscalationCase, string][] = [
      ['Pune access', { roleId: 'store_employee', storeIds: ['PUNE'] }, 'stores you cannot access'],
      ['all-store access', { roleId: 'store_employee', allStores: true }, 'all stores'],
      [
        'a role with more permissions',
        { roleId: 'org_admin', storeIds: ['HYD'] },
        'permissions you do not have',
      ],
    ];

    it.each(escalations)('cannot give %s', async (_case, request, message) => {
      const response = await api(lead.token).post('/members', {
        fullName: 'New Hire',
        phone: uniquePhone(),
        roleId: roleId[request.roleId],
        allStores: request.allStores ?? false,
        storeIds: (request.storeIds ?? []).map((code) => (code === 'HYD' ? hyd : pune)),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json<{ message: string }>().message).toContain(message);
    });

    it('sees Hyderabad staff and themselves, not Pune staff or all-store members', async () => {
      const hydStaff = await hire('store_employee', [hyd]);
      const puneStaff = await hire('store_employee', [pune]);

      const visible = (await api(lead.token).get('/members')).json<Member[]>().map((m) => m.id);

      expect(visible).toContain(hydStaff.member.id);
      expect(visible).toContain(lead.member.id);
      expect(visible).not.toContain(puneStaff.member.id);
      expect(visible).toHaveLength(2);
      expect((await api(lead.token).get(`/members/${puneStaff.member.id}`)).statusCode).toBe(404);
    });

    it('gets 404 when trying to change Pune-only staff, as if they did not exist', async () => {
      const puneStaff = await hire('store_employee', [pune]);

      const response = await api(lead.token).patch(`/members/${puneStaff.member.id}`, {
        isActive: false,
      });

      expect(response.statusCode).toBe(404);
    });

    it('cannot change someone who also works in Pune', async () => {
      const both = await hire('store_employee', [hyd, pune]);

      const response = await api(lead.token).patch(`/members/${both.member.id}`, {
        storeIds: [hyd],
      });

      expect(response.statusCode).toBe(403);
      expect(response.json<{ message: string }>().message).toBe(
        'This member has access you are not allowed to manage',
      );
    });
  });

  it('nobody can change their own access', async () => {
    const [self] = (await api(owner.token).get('/members')).json<Member[]>();

    const response = await api(owner.token).patch(`/members/${self?.id ?? ''}`, {
      isActive: false,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ message: string }>().message).toBe('You cannot change your own access');
  });

  it('an admin cannot change an owner', async () => {
    const admin = await hire('org_admin', [], { allStores: true });
    const [ownerMember] = (await api(owner.token).get('/members'))
      .json<Member[]>()
      .filter((m) => m.role.key === 'owner');

    const response = await api(admin.token).patch(`/members/${ownerMember?.id ?? ''}`, {
      isActive: false,
    });

    expect(response.statusCode).toBe(403);
  });

  it('an admin cannot promote someone to owner', async () => {
    const admin = await hire('org_admin', [], { allStores: true });
    const staff = await hire('store_employee', [hyd]);

    const response = await api(admin.token).patch(`/members/${staff.member.id}`, {
      roleId: roleId.owner,
    });

    expect(response.statusCode).toBe(403);
  });

  it('branch managers can view but not change the team', async () => {
    const manager = await hire('branch_manager', [hyd]);
    const staff = await hire('store_employee', [hyd]);

    expect((await api(manager.token).get(`/members/${staff.member.id}`)).statusCode).toBe(200);
    expect(
      (await api(manager.token).patch(`/members/${staff.member.id}`, { isActive: false }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await api(manager.token).post('/members', {
          fullName: 'Not Allowed',
          phone: uniquePhone(),
          roleId: roleId.store_employee,
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('PATCH /members/:id', () => {
  it('moves someone to another store, effective on their very next request', async () => {
    const staff = await hire('store_employee', [hyd]);

    const response = await api(owner.token).patch(`/members/${staff.member.id}`, {
      storeIds: [pune],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<Member>().storeIds).toEqual([pune]);
    const visible = (await api(staff.token).get('/stores')).json<{ id: string }[]>();
    expect(visible.map((s) => s.id)).toEqual([pune]);
  });

  it('changes someone’s role', async () => {
    const staff = await hire('store_employee', [hyd]);

    await api(owner.token).patch(`/members/${staff.member.id}`, {
      roleId: roleId.branch_manager,
    });

    const profile = (await api(staff.token).get('/auth/me')).json<{ role: { key: string } }>();
    expect(profile.role.key).toBe('branch_manager');
  });

  it('gives all-store access', async () => {
    const staff = await hire('inventory_manager', [hyd]);

    const response = await api(owner.token).patch(`/members/${staff.member.id}`, {
      allStores: true,
    });

    expect(response.json<Member>().allStores).toBe(true);
    expect((await api(staff.token).get('/stores')).json<unknown[]>()).toHaveLength(2);
  });

  it('deactivating signs the person out everywhere; reactivating lets them back in', async () => {
    const staff = await hire('store_employee', [hyd]);
    const secondDevice = await login(staff.phone);

    const deactivated = await api(owner.token).patch(`/members/${staff.member.id}`, {
      isActive: false,
    });

    expect(deactivated.json<Member>().isActive).toBe(false);
    expect((await api(staff.token).get('/auth/me')).statusCode).toBe(401);
    expect((await api(secondDevice).get('/auth/me')).statusCode).toBe(401);
    const liveSessions = await t.connection.db
      .select()
      .from(schema.sessions)
      .where(
        and(eq(schema.sessions.userId, staff.member.user.id), isNull(schema.sessions.revokedAt)),
      );
    expect(liveSessions).toEqual([]);

    await api(owner.token).patch(`/members/${staff.member.id}`, { isActive: true });
    expect((await api(await login(staff.phone)).get('/auth/me')).statusCode).toBe(200);
  });

  it('answers 400 for an empty change, an unknown role or an unknown store', async () => {
    const staff = await hire('store_employee', [hyd]);
    const url = `/members/${staff.member.id}`;

    expect((await api(owner.token).patch(url, {})).statusCode).toBe(400);
    expect(
      (await api(owner.token).patch(url, { roleId: '00000000-0000-4000-8000-000000000000' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await api(owner.token).patch(url, { storeIds: ['00000000-0000-4000-8000-000000000000'] }))
        .statusCode,
    ).toBe(400);
  });

  it('answers 404 for an unknown member and 400 for a malformed id', async () => {
    expect(
      (
        await api(owner.token).patch('/members/00000000-0000-4000-8000-000000000000', {
          isActive: true,
        })
      ).statusCode,
    ).toBe(404);
    expect((await api(owner.token).get('/members/nope')).statusCode).toBe(400);
  });
});

describe('another business', () => {
  it('cannot see or change ABC Paints’ team', async () => {
    const staff = await hire('store_employee', [hyd]);
    const rival = await signup('XYZ Paints');

    const list = (await api(rival.token).get('/members')).json<Member[]>();

    expect(list.map((m) => m.id)).not.toContain(staff.member.id);
    expect((await api(rival.token).get(`/members/${staff.member.id}`)).statusCode).toBe(404);
    expect(
      (await api(rival.token).patch(`/members/${staff.member.id}`, { isActive: false })).statusCode,
    ).toBe(404);
  });
});
