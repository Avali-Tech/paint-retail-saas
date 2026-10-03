import { migrateDatabase, schema } from '@paint/db';
import type { PendingSignIn, TwoFactorSignIn } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AuditPage } from '../audit/audit.service.js';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import { appCode } from '../test-support/two-factor.js';

const PASSWORD = 'Rangoli@2026';
const BOOTSTRAP_TOKEN = 'platform-bootstrap-token-for-two-factor-tests';

let database: TestDatabase;
let t: TestApp;
let owner: string;
let ownerPhone: string;
let organizationId: string;
const roleIds: Record<string, string> = {};

type Reply = Awaited<ReturnType<TestApp['app']['inject']>>;
const post = (url: string, payload: object = {}, token?: string) =>
  t.app.inject({ method: 'POST', url, payload, headers: token ? bearer(token) : {} });
const get = (url: string, token: string) =>
  t.app.inject({ method: 'GET', url, headers: bearer(token) });
const message = (reply: Reply) => reply.json<{ message: string }>().message;
const login = (identifier: string) => post('/auth/login', { identifier, password: PASSWORD });
const pendingOf = (reply: Reply) => reply.json<{ twoFactor: PendingSignIn }>().twoFactor;
/** A code from the app for the next 30-second step: never one the server has seen. */
const nextCode = (secret: string) => appCode(secret, Date.now() + 30_000);

/** Signs a new member in (by phone), returning their token and member id. */
async function hire(roleKey: string, allStores = false) {
  const phone = uniquePhone();
  const member = await post(
    '/members',
    {
      fullName: `Staff ${roleKey}`,
      phone,
      password: PASSWORD,
      roleId: roleIds[roleKey],
      allStores,
    },
    owner,
  );
  return { phone, memberId: member.json<{ id: string }>().id, first: await login(phone) };
}

/** Adds an app during sign-in and finishes it; returns the session, secret and recovery codes. */
async function setUpDuringSignIn(first: Reply) {
  const { pendingToken } = pendingOf(first);
  const setup = await post('/auth/2fa/setup', { pendingToken });
  const { secret } = setup.json<{ secret: string; otpauthUri: string }>();
  const done = (
    await post('/auth/2fa/verify', { pendingToken, code: appCode(secret) })
  ).json<TwoFactorSignIn>();
  return { token: done.token, secret, recoveryCodes: done.recoveryCodes ?? [], setup };
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString, { PLATFORM_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN });
  ownerPhone = uniquePhone();
  const signup = await post('/auth/signup', {
    organizationName: 'ABC Paints',
    fullName: 'Anil Owner',
    phone: ownerPhone,
    password: PASSWORD,
  });
  owner = signup.json<{ token: string }>().token;
  organizationId = signup.json<{ organizationId: string }>().organizationId;
  for (const role of (await get('/roles', owner)).json<{ id: string; key: string }[]>()) {
    roleIds[role.key] = role.id;
  }
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('owners, who must use two factors', () => {
  let secret: string;
  let recoveryCodes: string[];

  it('are sent to add an authenticator app after their password, with a token that is not a session', async () => {
    const first = await login(ownerPhone);

    expect(first.statusCode).toBe(200);
    const pending = pendingOf(first);
    expect(pending).toEqual({
      pendingToken: expect.any(String) as string,
      expiresAt: expect.any(String) as string,
      setupRequired: true,
    });
    expect(Date.parse(pending.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    expect((await get('/auth/me', pending.pendingToken)).statusCode).toBe(401);
  });

  it('add the app with a QR code, confirm it with its first code, and get recovery codes once', async () => {
    const first = await login(ownerPhone);
    const { pendingToken } = pendingOf(first);
    const setup = await post('/auth/2fa/setup', { pendingToken });
    const enrolment = setup.json<{ secret: string; otpauthUri: string }>();
    secret = enrolment.secret;
    const wrong = await post('/auth/2fa/verify', { pendingToken, code: '000000' });
    const right = await post('/auth/2fa/verify', { pendingToken, code: appCode(secret) });
    const again = await post('/auth/2fa/verify', { pendingToken, code: appCode(secret) });

    expect(setup.statusCode).toBe(200);
    expect(enrolment.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enrolment.otpauthUri).toBe(
      `otpauth://totp/Paint%20Retail%3A${encodeURIComponent(ownerPhone)}?secret=${secret}&issuer=Paint+Retail&algorithm=SHA1&digits=6&period=30`,
    );
    expect([wrong.statusCode, message(wrong)]).toEqual([401, 'Wrong code']);
    expect(right.statusCode).toBe(200);
    const signedIn = right.json<TwoFactorSignIn>();
    recoveryCodes = signedIn.recoveryCodes ?? [];
    expect(recoveryCodes).toHaveLength(10);
    expect(signedIn.organizationId).toBe(organizationId);
    expect((await get('/auth/me', signedIn.token)).statusCode).toBe(200);
    expect([again.statusCode, message(again)]).toEqual([401, 'Invalid or expired sign-in']);
    const stored = await t.connection.db.select().from(schema.userRecoveryCodes);
    expect(stored.map((row) => row.codeHash)).not.toContain(recoveryCodes[0]);
  });

  it('then sign in with a code from the app, which works only once', async () => {
    const code = nextCode(secret);
    const first = pendingOf(await login(ownerPhone));
    const second = pendingOf(await login(ownerPhone));

    expect(first.setupRequired).toBe(false);
    const signedIn = await post('/auth/2fa/verify', { pendingToken: first.pendingToken, code });
    const replay = await post('/auth/2fa/verify', { pendingToken: second.pendingToken, code });
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json<TwoFactorSignIn>().recoveryCodes).toBeUndefined();
    expect([replay.statusCode, message(replay)]).toEqual([401, 'Wrong code']);
  });

  it('or with a recovery code, each once, typed however', async () => {
    const [code = ''] = recoveryCodes;
    const typed = ` ${code.toUpperCase().replace('-', ' ')} `;
    const used = await post('/auth/2fa/verify', {
      pendingToken: pendingOf(await login(ownerPhone)).pendingToken,
      code: typed,
    });
    const reused = await post('/auth/2fa/verify', {
      pendingToken: pendingOf(await login(ownerPhone)).pendingToken,
      code,
    });

    expect(used.statusCode).toBe(200);
    expect(reused.statusCode).toBe(401);
    expect((await get('/auth/2fa', owner)).json()).toEqual({
      enabled: true,
      recoveryCodesLeft: 9,
      required: true,
    });
  });

  it('cannot turn it off while the business requires it', async () => {
    const response = await post('/auth/2fa/disable', { code: nextCode(secret) }, owner);

    expect([response.statusCode, message(response)]).toEqual([
      403,
      'Your business requires two-factor sign-in for your role',
    ]);
  });

  it('get five tries and five minutes per sign-in', async () => {
    const tries = pendingOf(await login(ownerPhone)).pendingToken;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        (await post('/auth/2fa/verify', { pendingToken: tries, code: '123456' })).statusCode,
      ).toBe(401);
    }
    const late = pendingOf(await login(ownerPhone)).pendingToken;
    await t.connection.db
      .update(schema.twoFactorChallenges)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(sql`${schema.twoFactorChallenges.createdAt} > now() - interval '1 second'`);

    expect(
      message(await post('/auth/2fa/verify', { pendingToken: tries, code: nextCode(secret) })),
    ).toBe('Invalid or expired sign-in');
    expect(
      (await post('/auth/2fa/verify', { pendingToken: late, code: nextCode(secret) })).statusCode,
    ).toBe(401);
    expect((await post('/auth/2fa/setup', { pendingToken: late })).statusCode).toBe(401);
  });

  it('cannot use a business sign-in token for the platform console', async () => {
    const { pendingToken } = pendingOf(await login(ownerPhone));

    expect(
      (await post('/platform/login/2fa', { pendingToken, code: nextCode(secret) })).statusCode,
    ).toBe(401);
  });
});

describe('members who choose two factors', () => {
  it('turn it on while signed in, renew recovery codes, and turn it off with a code', async () => {
    const manager = await hire('branch_manager');
    const token = manager.first.json<{ token: string }>().token;
    const early = await post('/auth/2fa/confirm', { code: '123456' }, token);
    const enrolment = (await post('/auth/2fa/enrol', {}, token)).json<{ secret: string }>();
    const wrongConfirm = await post('/auth/2fa/confirm', { code: '000000' }, token);
    const confirmed = await post('/auth/2fa/confirm', { code: appCode(enrolment.secret) }, token);
    const twice = await post('/auth/2fa/enrol', {}, token);

    expect(manager.first.json<{ token: string }>().token).toEqual(expect.any(String));
    expect([early.statusCode, message(early)]).toEqual([
      409,
      'Start adding an authenticator app first',
    ]);
    expect(wrongConfirm.statusCode).toBe(400);
    expect(confirmed.json<{ recoveryCodes: string[] }>().recoveryCodes).toHaveLength(10);
    expect([twice.statusCode, message(twice)]).toEqual([409, 'Two-factor sign-in is already on']);
    expect((await get('/auth/2fa', token)).json()).toEqual({
      enabled: true,
      recoveryCodesLeft: 10,
      required: false,
    });
    expect(pendingOf(await login(manager.phone)).setupRequired).toBe(false);

    const badRenew = await post('/auth/2fa/recovery-codes', { code: '000000' }, token);
    const renewed = await post(
      '/auth/2fa/recovery-codes',
      { code: nextCode(enrolment.secret) },
      token,
    );
    const badOff = await post('/auth/2fa/disable', { code: '000000' }, token);
    const [recovery = ''] = renewed.json<{ recoveryCodes: string[] }>().recoveryCodes;
    const off = await post('/auth/2fa/disable', { code: recovery }, token);

    expect(badRenew.statusCode).toBe(400);
    expect(renewed.statusCode).toBe(200);
    expect(badOff.statusCode).toBe(400);
    expect(off.statusCode).toBe(204);
    expect((await get('/auth/2fa', token)).json()).toMatchObject({
      enabled: false,
      recoveryCodesLeft: 0,
    });
    expect((await login(manager.phone)).json<{ token: string }>().token).toEqual(
      expect.any(String),
    );
    // With the app off, no code is accepted for its settings.
    expect((await post('/auth/2fa/recovery-codes', { code: '123456' }, token)).statusCode).toBe(
      400,
    );
  });

  it('refuse a code before the app has been added', async () => {
    const admin = await hire('org_admin', true);
    const { pendingToken } = pendingOf(admin.first);

    const response = await post('/auth/2fa/verify', { pendingToken, code: '123456' });

    expect([response.statusCode, message(response)]).toEqual([401, 'Wrong code']);
  });

  it('see the account by email when they have one', async () => {
    const email = `asha.${String(Date.now())}@abc.example`;
    await post(
      '/members',
      { fullName: 'Asha', email, password: PASSWORD, roleId: roleIds.store_employee },
      owner,
    );
    const token = (await login(email)).json<{ token: string }>().token;

    const enrolment = (await post('/auth/2fa/enrol', {}, token)).json<{ otpauthUri: string }>();

    expect(enrolment.otpauthUri).toContain(encodeURIComponent(email));
  });
});

describe('the business’s requirement', () => {
  it('can be turned off by those who manage the business, audited', async () => {
    const manager = await hire('branch_manager');
    const managerToken = manager.first.json<{ token: string }>().token;

    expect((await get('/organization/security', owner)).json()).toEqual({
      twoFactorRequired: true,
    });
    expect(
      (
        await t.app.inject({
          method: 'PUT',
          url: '/organization/security',
          headers: bearer(managerToken),
          payload: { twoFactorRequired: false },
        })
      ).statusCode,
    ).toBe(403);
    const off = await t.app.inject({
      method: 'PUT',
      url: '/organization/security',
      headers: bearer(owner),
      payload: { twoFactorRequired: false },
    });
    const admin = await hire('org_admin', true);

    expect(off.json()).toEqual({ twoFactorRequired: false });
    expect(admin.first.json<{ token: string }>().token).toEqual(expect.any(String));
    const audit = (await get('/audit-log?table=organizations', owner)).json<AuditPage>();
    expect(audit.items[0]?.changes.map((c) => [c.label, c.oldText, c.newText])).toEqual([
      ['Two-factor required', 'Yes', 'No'],
    ]);
    await t.app.inject({
      method: 'PUT',
      url: '/organization/security',
      headers: bearer(owner),
      payload: { twoFactorRequired: true },
    });
    const adminAgain = await login(admin.phone);
    expect(pendingOf(adminAgain).setupRequired).toBe(true);
  });
});

describe('an owner’s reset', () => {
  it('removes a member’s app and recovery codes and signs them out here, audited', async () => {
    const manager = await hire('branch_manager');
    const token = manager.first.json<{ token: string }>().token;
    const { secret } = (await post('/auth/2fa/enrol', {}, token)).json<{ secret: string }>();
    await post('/auth/2fa/confirm', { code: appCode(secret) }, token);

    const reset = await post(`/members/${manager.memberId}/two-factor/reset`, {}, owner);

    expect(reset.statusCode).toBe(204);
    expect((await get('/auth/me', token)).statusCode).toBe(401);
    const fresh = (await login(manager.phone)).json<{ token: string }>().token;
    expect((await get('/auth/2fa', fresh)).json()).toMatchObject({ enabled: false });
    const audit = (
      await get(`/audit-log?table=organization_members&recordId=${manager.memberId}`, owner)
    ).json<AuditPage>();
    expect(audit.items[0]).toMatchObject({ actor: { name: 'Anil Owner' } });
    expect(audit.items[0]?.changes.map((c) => c.label)).toEqual(['Two-factor reset']);
  });

  it('is for owners only, never on themselves, and only for members of the business', async () => {
    const admin = await hire('org_admin', true);
    const adminToken = (await setUpDuringSignIn(admin.first)).token;
    const manager = await hire('branch_manager');
    const [ownerMember] = await t.connection.db
      .select({ id: schema.organizationMembers.id })
      .from(schema.organizationMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.organizationMembers.userId))
      .where(eq(schema.users.phone, ownerPhone));

    const byAdmin = await post(`/members/${manager.memberId}/two-factor/reset`, {}, adminToken);
    const self = await post(`/members/${String(ownerMember?.id)}/two-factor/reset`, {}, owner);
    const ghost = await post(
      '/members/00000000-0000-4000-8000-000000000000/two-factor/reset',
      {},
      owner,
    );

    expect([byAdmin.statusCode, message(byAdmin)]).toEqual([
      403,
      'Only an owner can reset two-factor sign-in',
    ]);
    expect([self.statusCode, message(self)]).toEqual([
      400,
      'Ask another owner to reset your own two-factor sign-in',
    ]);
    expect(ghost.statusCode).toBe(404);
  });
});

describe('platform operators', () => {
  it('always sign in with two factors, adding the app the first time', async () => {
    await post('/platform/bootstrap', {
      token: BOOTSTRAP_TOKEN,
      fullName: 'Priya Support',
      email: 'priya@paintsaas.example',
      password: 'Platform@2026',
    });
    const signIn = () =>
      post('/platform/login', { identifier: 'priya@paintsaas.example', password: 'Platform@2026' });
    const first = pendingOf(await signIn());
    const setup = (
      await post('/platform/login/2fa/setup', { pendingToken: first.pendingToken })
    ).json<{ secret: string; otpauthUri: string }>();
    const done = (
      await post('/platform/login/2fa', {
        pendingToken: first.pendingToken,
        code: appCode(setup.secret),
      })
    ).json<{ token: string; recoveryCodes: string[] }>();
    const second = pendingOf(await signIn());
    const tenantToken = pendingOf(await login(ownerPhone)).pendingToken;
    const again = await post('/platform/login/2fa', {
      pendingToken: second.pendingToken,
      code: nextCode(setup.secret),
    });
    const crossed = await post('/auth/2fa/verify', {
      pendingToken: second.pendingToken,
      code: done.recoveryCodes[0],
    });

    expect(first.setupRequired).toBe(true);
    expect(setup.otpauthUri).toContain('issuer=Paint+Retail+platform');
    expect(done.recoveryCodes).toHaveLength(10);
    expect((await get('/platform/tenants', done.token)).statusCode).toBe(200);
    expect(second.setupRequired).toBe(false);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ recoveryCodes?: string[] }>().recoveryCodes).toBeUndefined();
    expect(crossed.statusCode).toBe(401);
    expect(tenantToken).toEqual(expect.any(String));
  });
});
