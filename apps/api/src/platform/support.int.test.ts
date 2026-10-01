import { migrateDatabase, schema } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { hashPassword } from '../auth/credentials.js';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import type { AccessLogEntry, GrantView } from './support.service.js';

const BOOTSTRAP_TOKEN = 'platform-bootstrap-token-for-support-tests';

let database: TestDatabase;
let t: TestApp;
let operator: string;
let otherOperator: string;
let otherOperatorUserId: string;
let owner: string;
let manager: string;
let ownerPhone: string;
let tenantId: string;

type Reply = Awaited<ReturnType<TestApp['app']['inject']>>;
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, payload?: object) =>
  t.app.inject({
    method,
    url,
    headers: token ? bearer(token) : {},
    ...(payload ? { payload } : {}),
  });
const message = (response: Reply) => response.json<{ message: string }>().message;

const ask = async (token = operator, business = tenantId, minutes = 30) =>
  (
    await call('POST', `/platform/tenants/${business}/support-requests`, token, {
      reason: 'Stock looks wrong at HYD',
      minutes,
    })
  ).json<GrantView>();
const approve = (grantId: string) => call('POST', `/support-requests/${grantId}/approve`, owner);
const startSession = (grantId: string, token = operator) =>
  call('POST', `/platform/support-grants/${grantId}/session`, token);
const supportToken = async (grantId: string) =>
  (await startSession(grantId)).json<{ token: string }>().token;

async function signInOperator(email: string, password: string): Promise<string> {
  return (await call('POST', '/platform/login', undefined, { identifier: email, password })).json<{
    token: string;
  }>().token;
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString, { PLATFORM_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN });
  operator = (
    await call('POST', '/platform/bootstrap', undefined, {
      token: BOOTSTRAP_TOKEN,
      fullName: 'Priya Support',
      email: 'priya@paintsaas.example',
      password: 'Platform@2026',
    })
  ).json<{ token: string }>().token;
  // A second operator, added directly (operator management comes later).
  const [user] = await t.connection.db
    .insert(schema.users)
    .values({
      fullName: 'Arjun Support',
      email: 'arjun@paintsaas.example',
      passwordHash: await hashPassword('Platform@2026'),
    })
    .returning({ id: schema.users.id });
  otherOperatorUserId = String(user?.id);
  await t.connection.db.insert(schema.platformAdmins).values({ userId: otherOperatorUserId });
  otherOperator = await signInOperator('arjun@paintsaas.example', 'Platform@2026');

  ownerPhone = uniquePhone();
  owner = (
    await call('POST', '/auth/signup', undefined, {
      organizationName: 'ABC Paints',
      fullName: 'Anil Owner',
      phone: ownerPhone,
      password: 'Owner@2026',
    })
  ).json<{ token: string; organizationId: string }>().token;
  tenantId = (await call('GET', '/auth/me', owner)).json<{ organization: { id: string } }>()
    .organization.id;
  const hyd = (await call('POST', '/stores', owner, { name: 'Hyderabad', code: 'HYD' })).json<{
    id: string;
  }>().id;
  const roles = (await call('GET', '/roles', owner)).json<{ id: string; key: string }[]>();
  const managerPhone = uniquePhone();
  await call('POST', '/members', owner, {
    fullName: 'Hyd Manager',
    phone: managerPhone,
    password: 'Staff@2026',
    roleId: roles.find((role) => role.key === 'branch_manager')?.id,
    storeIds: [hyd],
  });
  manager = (
    await call('POST', '/auth/login', undefined, {
      identifier: managerPhone,
      password: 'Staff@2026',
    })
  ).json<{
    token: string;
  }>().token;
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('asking for access', () => {
  it('tells the owner, who sees the pending request', async () => {
    const grant = await ask();
    const notices = (await call('GET', '/notifications', owner)).json<{
      items: { event: string; body: string; link: string }[];
    }>();
    const listed = (await call('GET', '/support-requests', owner)).json<GrantView[]>();

    expect(grant).toMatchObject({
      organization: { id: tenantId, name: 'ABC Paints' },
      requestedBy: 'Priya Support',
      reason: 'Stock looks wrong at HYD',
      minutes: 30,
      status: 'pending',
      approvedAt: null,
      expiresAt: null,
    });
    expect(notices.items[0]).toMatchObject({
      event: 'support_access_requested',
      link: `/settings/support/${grant.id}`,
      body: expect.stringContaining('Priya Support asks for 30 minutes of read-only access'),
    });
    expect(listed.map((g) => g.id)).toContain(grant.id);
    expect([
      (await startSession(grant.id)).statusCode,
      message(await startSession(grant.id)),
    ]).toEqual([409, 'This support access is pending']);
  });

  it('checks the request and who may decide', async () => {
    expect(
      (
        await call('POST', `/platform/tenants/${tenantId}/support-requests`, operator, {
          reason: 'x',
          minutes: 5,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          '/platform/tenants/00000000-0000-4000-8000-000000000000/support-requests',
          operator,
          { reason: 'Check' },
        )
      ).statusCode,
    ).toBe(404);
    expect((await call('GET', '/support-requests', manager)).statusCode).toBe(403);
    expect(
      (await call('POST', '/support-requests/00000000-0000-4000-8000-000000000000/approve', owner))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('GET', '/support-requests/00000000-0000-4000-8000-000000000000/activity', owner))
        .statusCode,
    ).toBe(404);
  });
});

describe('approved access', () => {
  it('lets the operator who asked look around, read-only, with every request logged', async () => {
    const grant = await ask();
    const approved = (await approve(grant.id)).json<GrantView>();
    const twice = await approve(grant.id);
    const notYours = await startSession(grant.id, otherOperator);
    const session = await startSession(grant.id);
    const support = session.json<{ token: string; expiresAt: string; organizationId: string }>();

    expect(approved).toMatchObject({ status: 'active', approvedAt: expect.any(String) });
    expect(Date.parse(String(approved.expiresAt)) - Date.now()).toBeGreaterThan(29 * 60_000);
    expect([twice.statusCode, message(twice)]).toEqual([409, 'This support request is active']);
    expect([notYours.statusCode, message(notYours)]).toEqual([
      403,
      'Only the operator who asked can use this access',
    ]);
    expect(session.statusCode).toBe(201);
    expect(support).toMatchObject({ organizationId: tenantId, expiresAt: approved.expiresAt });

    const me = (await call('GET', '/auth/me', support.token)).json<{
      role: { key: string; name: string };
      permissions: string[];
    }>();
    const stock = await call('GET', '/stock', support.token);
    const change = await call('POST', '/stores', support.token, { name: 'Sneaky', code: 'SNK' });

    expect(me.role).toEqual({ key: 'support', name: 'Platform support' });
    expect(me.permissions.every((permission) => permission.endsWith(':read'))).toBe(true);
    expect(stock.statusCode).toBe(200);
    expect(change.statusCode).toBe(403);

    const activity = (await call('GET', `/support-requests/${grant.id}/activity`, owner)).json<
      AccessLogEntry[]
    >();
    expect(activity.map((entry) => [entry.method, entry.path])).toEqual([
      ['GET', '/auth/me'],
      ['GET', '/stock'],
      ['POST', '/stores'],
    ]);
    // Support is not part of the team, and its role is not offered.
    const members = (await call('GET', '/members', owner)).json<{ user: { fullName: string } }[]>();
    expect(members.map((m) => m.user.fullName)).not.toContain('Priya Support');
    expect(
      (await call('GET', '/roles', owner)).json<{ key: string }[]>().map((r) => r.key),
    ).not.toContain('support');
    const audit = (await call('GET', '/audit-log?table=support_grants', owner)).json<{
      items: { action: string; recordLabel: string }[];
    }>();
    expect(audit.items.map((e) => e.action)).toEqual(expect.arrayContaining(['insert', 'update']));
    expect(audit.items[0]?.recordLabel).toBe('Stock looks wrong at HYD');

    // Another session on the same grant reuses the support membership.
    expect((await startSession(grant.id)).statusCode).toBe(201);
  });

  it('ends at once when the business ends it', async () => {
    const grant = await ask();
    await approve(grant.id);
    const token = await supportToken(grant.id);

    const ended = (
      await call('POST', `/support-requests/${grant.id}/end`, owner)
    ).json<GrantView>();
    const again = await call('POST', `/support-requests/${grant.id}/end`, owner);

    expect(ended).toMatchObject({ status: 'ended', endedAt: expect.any(String) });
    expect((await call('GET', '/auth/me', token)).statusCode).toBe(401);
    expect([again.statusCode, message(again)]).toEqual([409, 'This support access is ended']);
    expect(message(await startSession(grant.id))).toBe('This support access is ended');
    expect(
      (await call('POST', '/support-requests/00000000-0000-4000-8000-000000000000/end', owner))
        .statusCode,
    ).toBe(404);
  });

  it('ends when the platform ends it, or when its time runs out', async () => {
    const byPlatform = await ask();
    await approve(byPlatform.id);
    const token = await supportToken(byPlatform.id);
    const ended = (
      await call('POST', `/platform/support-grants/${byPlatform.id}/end`, operator)
    ).json<GrantView>();

    const timed = await ask(operator, tenantId, 15);
    await approve(timed.id);
    const timedToken = await supportToken(timed.id);
    await t.connection.db
      .update(schema.supportGrants)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(schema.supportGrants.id, timed.id));

    expect(ended.status).toBe('ended');
    expect((await call('GET', '/auth/me', token)).statusCode).toBe(401);
    expect((await call('GET', '/auth/me', timedToken)).statusCode).toBe(401);
    expect(message(await startSession(timed.id))).toBe('This support access is expired');
    expect(
      (
        await call(
          'POST',
          '/platform/support-grants/00000000-0000-4000-8000-000000000000/end',
          operator,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('can be declined', async () => {
    const grant = await ask();

    const declined = (
      await call('POST', `/support-requests/${grant.id}/decline`, owner)
    ).json<GrantView>();
    const again = await call('POST', `/support-requests/${grant.id}/decline`, owner);

    expect(declined).toMatchObject({
      status: 'declined',
      declinedAt: expect.any(String),
      expiresAt: null,
    });
    expect(message(again)).toBe('This support request is declined');
    expect(message(await startSession(grant.id))).toBe('This support access is declined');
  });
});

describe('special cases', () => {
  it('still lets support look into a suspended business', async () => {
    const grant = await ask();
    await approve(grant.id);
    const token = await supportToken(grant.id);

    await call('POST', `/platform/tenants/${tenantId}/suspend`, operator, {
      reason: 'Checking a billing dispute',
    });
    const supportStill = await call('GET', '/auth/me', token);
    const ownerOut = await call('POST', '/auth/login', undefined, {
      identifier: ownerPhone,
      password: 'Owner@2026',
    });
    await call('POST', `/platform/tenants/${tenantId}/reactivate`, operator);
    owner = (
      await call('POST', '/auth/login', undefined, {
        identifier: ownerPhone,
        password: 'Owner@2026',
      })
    ).json<{
      token: string;
    }>().token;

    expect(supportStill.statusCode).toBe(200);
    expect(ownerOut.statusCode).toBe(403);
  });

  it('sends an operator who works at the business to its normal sign-in', async () => {
    const roles = (await call('GET', '/roles', owner)).json<{ id: string; key: string }[]>();
    await t.connection.db.insert(schema.organizationMembers).values({
      organizationId: tenantId,
      userId: otherOperatorUserId,
      roleId: String(roles.find((role) => role.key === 'store_employee')?.id),
    });
    const grant = await ask(otherOperator);
    await approve(grant.id);

    const response = await startSession(grant.id, otherOperator);

    expect([response.statusCode, message(response)]).toEqual([
      409,
      'You work at this business; sign in to it normally',
    ]);
  });

  it('lists every grant for the platform, or one business’s', async () => {
    const all = (await call('GET', '/platform/support-grants', operator)).json<GrantView[]>();
    const one = (await call('GET', `/platform/support-grants?tenantId=${tenantId}`, operator)).json<
      GrantView[]
    >();
    const none = (
      await call(
        'GET',
        '/platform/support-grants?tenantId=00000000-0000-4000-8000-000000000000',
        operator,
      )
    ).json<GrantView[]>();

    expect(all.length).toBeGreaterThanOrEqual(7);
    expect(one).toHaveLength(all.length);
    expect(none).toEqual([]);
    expect(new Set(all.map((g) => g.status))).toEqual(
      new Set(['pending', 'active', 'ended', 'expired', 'declined']),
    );
  });
});
