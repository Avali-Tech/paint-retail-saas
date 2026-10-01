import { migrateDatabase } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import type { TenantDetail, TenantView } from './tenants.service.js';

const BOOTSTRAP_TOKEN = 'platform-bootstrap-token-for-integration-tests';

let database: TestDatabase;
let t: TestApp;
let operator: string;

type Reply = Awaited<ReturnType<TestApp['app']['inject']>>;
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, payload?: object) =>
  t.app.inject({
    method,
    url,
    headers: token ? bearer(token) : {},
    ...(payload ? { payload } : {}),
  });
const message = (response: Reply) => response.json<{ message: string }>().message;

/** Signs a business's owner in with a one-time code, as they would on their phone. */
async function otpSignIn(phone: string, organizationId?: string): Promise<Reply> {
  await call('POST', '/auth/otp/request', undefined, { phone });
  return call('POST', '/auth/otp/verify', undefined, {
    phone,
    code: t.sms.lastCodeFor(phone),
    ...(organizationId ? { organizationId } : {}),
  });
}

async function newTenant(name: string, phone = uniquePhone(), extra: object = {}) {
  const response = await call('POST', '/platform/tenants', operator, {
    organizationName: name,
    owner: { fullName: `${name} Owner`, phone },
    ...extra,
  });
  return { response, tenant: response.json<TenantDetail>(), phone };
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString, { PLATFORM_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN });
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('platform sign-in', () => {
  it('creates the first operator once, with the bootstrap token', async () => {
    const off = await startTestApp(database.connectionString);
    try {
      const noToken = await off.app.inject({
        method: 'POST',
        url: '/platform/bootstrap',
        payload: {
          token: BOOTSTRAP_TOKEN,
          fullName: 'Ops',
          email: 'ops@x.example',
          password: 'Platform@2026',
        },
      });
      expect([noToken.statusCode, message(noToken)]).toEqual([404, 'Bootstrap is turned off']);
    } finally {
      await off.close();
    }
    const opsPhone = uniquePhone();
    const body = {
      fullName: 'Priya Ops',
      email: 'priya@paintsaas.example',
      phone: opsPhone,
      password: 'Platform@2026',
    };

    const wrong = await call('POST', '/platform/bootstrap', undefined, {
      ...body,
      token: 'not-the-token',
    });
    const missing = await call('POST', '/platform/bootstrap', undefined, {
      token: BOOTSTRAP_TOKEN,
      fullName: 'X',
      password: 'Platform@2026',
    });
    const first = await call('POST', '/platform/bootstrap', undefined, {
      ...body,
      token: BOOTSTRAP_TOKEN,
    });
    const second = await call('POST', '/platform/bootstrap', undefined, {
      ...body,
      email: 'other@paintsaas.example',
      token: BOOTSTRAP_TOKEN,
    });

    expect([wrong.statusCode, message(wrong)]).toEqual([403, 'Wrong bootstrap token']);
    expect(missing.statusCode).toBe(400);
    expect(first.statusCode).toBe(201);
    operator = first.json<{ token: string }>().token;
    expect([second.statusCode, message(second)]).toEqual([
      409,
      'The platform already has operators; sign in instead',
    ]);
    const byPhone = await call('POST', '/platform/login', undefined, {
      identifier: opsPhone,
      password: 'Platform@2026',
    });
    expect(byPhone.statusCode).toBe(200);
  });

  it('signs operators in and out with their own tokens, which businesses’ tokens cannot replace', async () => {
    const wrong = await call('POST', '/platform/login', undefined, {
      identifier: 'priya@paintsaas.example',
      password: 'nope',
    });
    const right = await call('POST', '/platform/login', undefined, {
      identifier: 'PRIYA@paintsaas.example',
      password: 'Platform@2026',
    });
    const session = right.json<{ token: string; expiresAt: string }>();
    const signup = await call('POST', '/auth/signup', undefined, {
      organizationName: 'Self Signup Paints',
      fullName: 'Self Owner',
      phone: uniquePhone(),
      password: 'Owner@2026',
    });
    const tenantToken = signup.json<{ token: string }>().token;

    expect(wrong.statusCode).toBe(401);
    expect(right.statusCode).toBe(200);
    expect(Date.parse(session.expiresAt) - Date.now()).toBeGreaterThan(11 * 3_600_000);
    // A business owner is not an operator, and the two kinds of token do not mix.
    expect(
      (
        await call('POST', '/platform/login', undefined, {
          identifier: 'nobody@x.example',
          password: 'Owner@2026',
        })
      ).statusCode,
    ).toBe(401);
    expect((await call('GET', '/platform/tenants', tenantToken)).statusCode).toBe(401);
    expect((await call('GET', '/auth/me', session.token)).statusCode).toBe(401);
    expect((await call('GET', '/platform/tenants')).statusCode).toBe(401);

    expect((await call('POST', '/platform/logout', session.token)).statusCode).toBe(204);
    expect((await call('GET', '/platform/tenants', session.token)).statusCode).toBe(401);
  });
});

describe('onboarding a business', () => {
  it('creates a business and its owner, who signs in with a one-time code', async () => {
    const { response, tenant, phone } = await newTenant('Lakshmi Paints', uniquePhone(), {
      plan: 'standard',
    });

    expect(response.statusCode).toBe(201);
    expect(tenant).toMatchObject({
      name: 'Lakshmi Paints',
      plan: { key: 'standard', name: 'Standard', maxStores: 10, maxMembers: 50 },
      status: 'active',
      features: { advanced_reports: true, loyalty: false },
      featureOverrides: {},
      usage: {
        stores: 0,
        members: 1,
        products: 0,
        parties: 0,
        documents: 0,
        documentBytes: 0,
        lastSignInAt: null,
      },
      owners: [{ fullName: 'Lakshmi Paints Owner', phone, email: null }],
    });

    const signIn = await otpSignIn(phone);
    expect(signIn.statusCode).toBe(200);
    const owner = signIn.json<{ token: string }>().token;
    const me = (await call('GET', '/auth/me', owner)).json<{
      organization: { name: string };
      role: { key: string };
    }>();
    expect(me).toMatchObject({ organization: { name: 'Lakshmi Paints' }, role: { key: 'owner' } });
    await call('POST', '/stores', owner, { name: 'Vijayawada', code: 'VJA' });

    const after = (
      await call('GET', `/platform/tenants/${tenant.id}`, operator)
    ).json<TenantDetail>();
    expect(after.usage).toMatchObject({ stores: 1, members: 1, lastSignInAt: expect.any(String) });
  });

  it('lets an existing account own another business, and refuses an email that belongs to someone else', async () => {
    const { tenant: first, phone } = await newTenant('First Business');
    const { tenant: second } = await newTenant('Second Business', phone);
    const taken = await call('POST', '/platform/tenants', operator, {
      organizationName: 'Third Business',
      owner: { fullName: 'Someone', phone: uniquePhone(), email: 'priya@paintsaas.example' },
    });

    expect(second.owners[0]?.phone).toBe(phone);
    // Owning two businesses, the owner chooses one when signing in.
    expect((await otpSignIn(phone, first.id)).statusCode).toBe(200);
    expect([taken.statusCode, message(taken)]).toEqual([
      409,
      'That email address belongs to another account',
    ]);
  });

  it('lists businesses by name and status, newest first', async () => {
    const all = (await call('GET', '/platform/tenants?limit=200', operator)).json<{
      items: TenantView[];
      total: number;
    }>();
    const found = (await call('GET', '/platform/tenants?q=lakshmi', operator)).json<{
      items: TenantView[];
    }>();
    const active = (await call('GET', '/platform/tenants?status=active&limit=1', operator)).json<{
      total: number;
    }>();
    const suspended = (await call('GET', '/platform/tenants?status=suspended', operator)).json<{
      total: number;
    }>();

    expect(all.total).toBeGreaterThanOrEqual(4);
    expect(all.items[0]?.name).toBe('Second Business');
    expect(found.items.map((tenant) => tenant.name)).toEqual(['Lakshmi Paints']);
    expect(active.total).toBe(all.total);
    expect(suspended.total).toBe(0);
    expect(
      (await call('GET', '/platform/tenants/00000000-0000-4000-8000-000000000000', operator))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('POST', '/platform/tenants', operator, { organizationName: 'X' })).statusCode,
    ).toBe(400);
  });
});

describe('plans and features', () => {
  it('changes plans and features, which the business sees and finds in its audit log', async () => {
    const { tenant, phone } = await newTenant('Flag Paints');
    const owner = (await otpSignIn(phone)).json<{ token: string }>().token;

    const updated = (
      await call('PATCH', `/platform/tenants/${tenant.id}`, operator, {
        name: 'Flag Paints & Hardware',
        plan: 'standard',
        featureFlags: { loyalty: true, advanced_reports: false },
      })
    ).json<TenantDetail>();
    const seen = (await call('GET', '/organization/features', owner)).json<{
      plan: { key: string; maxStores: number };
      usage: { stores: number; members: number };
      features: Record<string, boolean>;
    }>();
    const cleared = (
      await call('PATCH', `/platform/tenants/${tenant.id}`, operator, {
        featureFlags: { advanced_reports: null },
      })
    ).json<TenantDetail>();
    const audit = (await call('GET', '/audit-log?table=organizations', owner)).json<{
      items: { changes: { field: string }[] }[];
    }>();

    expect(updated).toMatchObject({
      name: 'Flag Paints & Hardware',
      plan: { key: 'standard' },
      featureOverrides: { loyalty: true, advanced_reports: false },
      features: { loyalty: true, advanced_reports: false },
    });
    expect(seen).toMatchObject({
      plan: { key: 'standard', maxStores: 10 },
      usage: { stores: 0, members: 1 },
      features: { loyalty: true, advanced_reports: false },
    });
    expect(cleared).toMatchObject({
      featureOverrides: { loyalty: true },
      features: { advanced_reports: true },
    });
    expect(audit.items.length).toBeGreaterThan(0);
    expect((await call('PATCH', `/platform/tenants/${tenant.id}`, operator, {})).statusCode).toBe(
      400,
    );
  });

  it('keeps a business within its plan’s stores and team, and lifts limits on Enterprise', async () => {
    const { tenant, phone } = await newTenant('Limit Paints');
    const owner = (await otpSignIn(phone)).json<{ token: string }>().token;
    for (let i = 1; i <= 5; i += 1) {
      expect(
        (
          await call('POST', '/stores', owner, {
            name: `Store ${String(i)}`,
            code: `ST${String(i)}`,
          })
        ).statusCode,
      ).toBe(201);
    }
    const roles = (await call('GET', '/roles', owner)).json<{ id: string; key: string }[]>();
    const cashierRole = roles.find((role) => role.key === 'store_employee')?.id;
    const addMember = (n: number) =>
      call('POST', '/members', owner, {
        fullName: `Member ${String(n)}`,
        phone: uniquePhone(),
        roleId: cashierRole,
        allStores: true,
      });

    const sixthStore = await call('POST', '/stores', owner, { name: 'Store 6', code: 'ST6' });
    const memberIds: string[] = [];
    for (let i = 2; i <= 25; i += 1) memberIds.push((await addMember(i)).json<{ id: string }>().id);
    const tooMany = await addMember(26);
    await call('PATCH', `/members/${String(memberIds[0])}`, owner, { isActive: false });
    await addMember(27);
    const reactivate = await call('PATCH', `/members/${String(memberIds[0])}`, owner, {
      isActive: true,
    });

    expect([sixthStore.statusCode, message(sixthStore)]).toEqual([
      403,
      'The Trial plan allows 5 active stores. Ask us to upgrade your plan.',
    ]);
    expect([tooMany.statusCode, message(tooMany)]).toEqual([
      403,
      'The Trial plan allows 25 active team members. Ask us to upgrade your plan.',
    ]);
    expect(reactivate.statusCode).toBe(403);

    await call('PATCH', `/platform/tenants/${tenant.id}`, operator, { plan: 'enterprise' });
    expect(
      (await call('POST', '/stores', owner, { name: 'Store 6', code: 'ST6' })).statusCode,
    ).toBe(201);
    expect((await addMember(28)).statusCode).toBe(201);
  });
});

describe('suspension', () => {
  it('signs a suspended business out and keeps it out until reactivated', async () => {
    // An owner with a password, so they can sign in again and again.
    const phone = uniquePhone();
    await call('POST', '/auth/signup', undefined, {
      organizationName: 'Their Own Paints',
      fullName: 'Password Owner',
      phone,
      password: 'Owner@2026',
    });
    const { tenant } = await newTenant('Late Payer Paints', phone);
    const signIn = () =>
      call('POST', '/auth/login', undefined, {
        identifier: phone,
        password: 'Owner@2026',
        organizationId: tenant.id,
      });
    const owner = (await signIn()).json<{ token: string }>().token;

    const suspended = (
      await call('POST', `/platform/tenants/${tenant.id}/suspend`, operator, {
        reason: 'Invoice unpaid for 60 days',
      })
    ).json<TenantDetail>();
    const again = await call('POST', `/platform/tenants/${tenant.id}/suspend`, operator, {
      reason: 'Again',
    });
    const oldSession = await call('GET', '/auth/me', owner);
    const blocked = await signIn();
    const listed = (await call('GET', '/platform/tenants?status=suspended', operator)).json<{
      items: TenantView[];
    }>();

    expect(suspended).toMatchObject({
      status: 'suspended',
      suspendedAt: expect.any(String),
      suspendReason: 'Invoice unpaid for 60 days',
    });
    expect(again.statusCode).toBe(409);
    expect(oldSession.statusCode).toBe(401);
    expect([blocked.statusCode, message(blocked)]).toEqual([
      403,
      'This business is suspended. Please contact support.',
    ]);
    expect(listed.items.map((item) => item.id)).toEqual([tenant.id]);

    const reactivated = (
      await call('POST', `/platform/tenants/${tenant.id}/reactivate`, operator)
    ).json<TenantDetail>();
    const back = await signIn();
    const audit = (
      await call('GET', '/audit-log?table=organizations', back.json<{ token: string }>().token)
    ).json<{
      items: {
        area: string;
        recordLabel: string;
        changes: { label: string; newText: string | null }[];
      }[];
    }>();

    expect(reactivated).toMatchObject({ status: 'active', suspendedAt: null, suspendReason: null });
    expect(back.statusCode).toBe(200);
    expect(audit.items[0]).toMatchObject({
      area: 'Plan and account',
      recordLabel: 'Late Payer Paints',
    });
    expect(audit.items.flatMap((e) => e.changes.map((c) => c.label))).toContain(
      'Suspension reason',
    );
    expect(
      (await call('POST', `/platform/tenants/${tenant.id}/reactivate`, operator)).statusCode,
    ).toBe(409);
  });
});
