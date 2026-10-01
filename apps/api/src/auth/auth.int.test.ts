import { migrateDatabase, schema } from '@paint/db';
import { PERMISSIONS, SYSTEM_ROLES } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  addMember,
  addMembership,
  bearer,
  startTestApp,
  uniquePhone,
  type TestApp,
} from '../test-support/test-app.js';

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

interface Grant {
  token: string;
  expiresAt: string;
  organizationId: string;
}

async function signup(overrides: Record<string, unknown> = {}) {
  const phone = uniquePhone();
  const response = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: 'ABC Paints',
      fullName: 'Kamal Singh',
      phone,
      password: 'Rangoli@2026',
      ...overrides,
    },
  });
  return { response, phone, grant: response.json<Grant>() };
}

const me = (token: string) =>
  t.app.inject({ method: 'GET', url: '/auth/me', headers: bearer(token) });

const login = (payload: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url: '/auth/login', payload });

const requestOtp = (phone: string) =>
  t.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone } });

const verifyOtp = (payload: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url: '/auth/otp/verify', payload });

describe('POST /auth/signup', () => {
  it('creates the business, signs the owner in, and gives them full access', async () => {
    const { response, grant, phone } = await signup({ organizationName: 'Rainbow Paints' });

    expect(response.statusCode).toBe(201);
    expect(grant.token).toMatch(/^[\w-]{43}$/);
    const days = (Date.parse(grant.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);

    const profile = await me(grant.token);
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toEqual({
      user: { id: expect.any(String), fullName: 'Kamal Singh', phone, email: null },
      organization: { id: grant.organizationId, name: 'Rainbow Paints' },
      role: { key: 'owner', name: 'Owner' },
      permissions: [...PERMISSIONS].sort(),
      allStores: true,
      storeIds: [],
    });
  });

  it('creates every standard role with its permissions', async () => {
    const { grant } = await signup();

    const roles = await t.connection.db
      .select({ key: schema.roles.key, isSystem: schema.roles.isSystem })
      .from(schema.roles)
      .where(eq(schema.roles.organizationId, grant.organizationId));
    const permissions = await t.connection.db
      .select()
      .from(schema.rolePermissions)
      .where(eq(schema.rolePermissions.organizationId, grant.organizationId));

    expect(roles.map((r) => r.key).sort()).toEqual(SYSTEM_ROLES.map((r) => r.key).sort());
    expect(roles.every((r) => r.isSystem)).toBe(true);
    expect(permissions).toHaveLength(
      SYSTEM_ROLES.reduce((total, role) => total + role.permissions.length, 0),
    );
  });

  it('stores the password hashed, never as typed', async () => {
    const { phone } = await signup({ password: 'Rangoli@2026' });

    const [user] = await t.connection.db
      .select({ passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.phone, phone));
    expect(user?.passwordHash).toMatch(/^scrypt\$/);
    expect(user?.passwordHash).not.toContain('Rangoli');
  });

  it('refuses a mobile number that already has an account, however it is written', async () => {
    const { phone } = await signup();
    const national = phone.slice(3);

    const { response } = await signup({ phone: `${national.slice(0, 5)} ${national.slice(5)}` });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toMatch(/Sign in instead/);
  });

  it('refuses an email that already has an account, ignoring case', async () => {
    await signup({ phone: undefined, email: 'owner@rainbow.in' });

    const { response } = await signup({ phone: undefined, email: 'Owner@Rainbow.IN' });

    expect(response.statusCode).toBe(409);
  });

  it.each([
    [{ phone: undefined }, 'phone'],
    [{ password: 'short' }, 'password'],
    [{ phone: '12345' }, 'phone'],
    [{ email: 'not-an-email' }, 'email'],
    [{ organizationName: 'A' }, 'organizationName'],
  ])('answers 400 for %o', async (overrides, field) => {
    const { response } = await signup(overrides);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ issues: { path: string }[] }>().issues.map((i) => i.path)).toContain(
      field,
    );
  });
});

describe('POST /auth/login (password)', () => {
  it('signs in with an email address in any case', async () => {
    await signup({ phone: undefined, email: 'asha@abcpaints.in', password: 'Rangoli@2026' });

    const response = await login({ identifier: 'ASHA@abcpaints.in', password: 'Rangoli@2026' });

    expect(response.statusCode).toBe(200);
    expect((await me(response.json<Grant>().token)).statusCode).toBe(200);
  });

  it('signs in with a 10-digit mobile number', async () => {
    const { phone } = await signup({ password: 'Rangoli@2026' });

    const response = await login({ identifier: phone.slice(3), password: 'Rangoli@2026' });

    expect(response.statusCode).toBe(200);
  });

  it('gives the same answer for a wrong password, an unknown account and nonsense', async () => {
    const { phone } = await signup({ password: 'Rangoli@2026' });

    const responses = await Promise.all([
      login({ identifier: phone, password: 'wrong-password' }),
      login({ identifier: uniquePhone(), password: 'Rangoli@2026' }),
      login({ identifier: 'nobody@nowhere.in', password: 'Rangoli@2026' }),
      login({ identifier: 'abc', password: 'Rangoli@2026' }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json<{ message: string }>().message).toBe('Invalid sign-in details');
    }
  });

  it('refuses password sign-in for people who only use OTP', async () => {
    const { grant } = await signup();
    const phone = uniquePhone();
    await addMember(t.connection, {
      organizationId: grant.organizationId,
      roleKey: 'store_employee',
      phone,
    });

    expect((await login({ identifier: phone, password: 'anything-at-all' })).statusCode).toBe(401);
  });

  it('refuses deactivated people', async () => {
    const { phone } = await signup({ password: 'Rangoli@2026' });
    await t.connection.db
      .update(schema.users)
      .set({ isActive: false })
      .where(eq(schema.users.phone, phone));

    expect((await login({ identifier: phone, password: 'Rangoli@2026' })).statusCode).toBe(401);
  });

  it('refuses people who no longer belong to any business', async () => {
    const { phone, grant } = await signup({ password: 'Rangoli@2026' });
    await t.connection.db
      .update(schema.organizationMembers)
      .set({ isActive: false })
      .where(eq(schema.organizationMembers.organizationId, grant.organizationId));

    expect((await login({ identifier: phone, password: 'Rangoli@2026' })).statusCode).toBe(401);
  });

  describe('someone who works for two businesses', () => {
    it('is asked to choose, then signs in to the chosen business', async () => {
      const first = await signup({ organizationName: 'Alpha Paints', password: 'Rangoli@2026' });
      const second = await signup({ organizationName: 'Beta Paints' });
      const [user] = await t.connection.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.phone, first.phone));
      await addMembership(t.connection, user?.id ?? '', {
        organizationId: second.grant.organizationId,
        roleKey: 'branch_manager',
      });

      const choice = await login({ identifier: first.phone, password: 'Rangoli@2026' });
      expect(choice.statusCode).toBe(409);
      expect(choice.json<{ organizations: { name: string }[] }>().organizations).toEqual([
        { id: first.grant.organizationId, name: 'Alpha Paints' },
        { id: second.grant.organizationId, name: 'Beta Paints' },
      ]);

      const chosen = await login({
        identifier: first.phone,
        password: 'Rangoli@2026',
        organizationId: second.grant.organizationId,
      });
      expect(chosen.statusCode).toBe(200);
      const profile = (await me(chosen.json<Grant>().token)).json<{
        organization: { name: string };
        role: { key: string };
      }>();
      expect(profile.organization.name).toBe('Beta Paints');
      expect(profile.role.key).toBe('branch_manager');
    });

    it('cannot sign in to a business they do not belong to', async () => {
      const { phone } = await signup({ password: 'Rangoli@2026' });
      const other = await signup();

      const response = await login({
        identifier: phone,
        password: 'Rangoli@2026',
        organizationId: other.grant.organizationId,
      });

      expect(response.statusCode).toBe(401);
    });
  });
});

describe('sessions', () => {
  it.each([
    ['no header', {}],
    ['a malformed header', { authorization: 'Token abc' }],
    ['an unknown token', bearer('x'.repeat(43))],
  ])('protects private routes: %s answers 401', async (_case, headers) => {
    const response = await t.app.inject({ method: 'GET', url: '/auth/me', headers });

    expect(response.statusCode).toBe(401);
  });

  it('signing out ends only this device’s session', async () => {
    const { grant, phone } = await signup({ password: 'Rangoli@2026' });
    const otherDevice = (
      await login({ identifier: phone, password: 'Rangoli@2026' })
    ).json<Grant>();

    const logout = await t.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: bearer(grant.token),
    });

    expect(logout.statusCode).toBe(204);
    expect((await me(grant.token)).statusCode).toBe(401);
    expect((await me(otherDevice.token)).statusCode).toBe(200);
  });

  it('stops working once expired', async () => {
    const { grant } = await signup();
    await t.connection.db
      .update(schema.sessions)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(schema.sessions.organizationId, grant.organizationId));

    expect((await me(grant.token)).statusCode).toBe(401);
  });

  it('stops working as soon as the person is removed from the business', async () => {
    const { grant } = await signup();
    await t.connection.db
      .update(schema.organizationMembers)
      .set({ isActive: false })
      .where(eq(schema.organizationMembers.organizationId, grant.organizationId));

    expect((await me(grant.token)).statusCode).toBe(401);
  });

  it('stores only a hash of the token', async () => {
    const { grant } = await signup();

    const stored = await t.connection.db
      .select({ tokenHash: schema.sessions.tokenHash })
      .from(schema.sessions)
      .where(eq(schema.sessions.organizationId, grant.organizationId));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]?.tokenHash).not.toBe(grant.token);
  });
});

describe('OTP sign-in', () => {
  it('texts a 6-digit code that signs the person in', async () => {
    const { phone, grant } = await signup();

    const request = await requestOtp(phone.slice(3));
    expect(request.statusCode).toBe(202);
    const code = t.sms.lastCodeFor(phone);

    const verify = await verifyOtp({ phone, code });
    expect(verify.statusCode).toBe(200);
    expect(verify.json<Grant>().organizationId).toBe(grant.organizationId);
    expect((await me(verify.json<Grant>().token)).statusCode).toBe(200);
  });

  it('answers the same for an unregistered number, without sending or storing anything', async () => {
    const phone = uniquePhone();
    const sentBefore = t.sms.sent.length;

    const response = await requestOtp(phone);

    expect(response.statusCode).toBe(202);
    expect(t.sms.sent.length).toBe(sentBefore);
    const challenges = await t.connection.db
      .select()
      .from(schema.otpChallenges)
      .where(eq(schema.otpChallenges.phone, phone));
    expect(challenges).toEqual([]);
  });

  it('answers 400 for an invalid mobile number', async () => {
    expect((await requestOtp('12345')).statusCode).toBe(400);
  });

  it('stores only a keyed hash of the code', async () => {
    const { phone } = await signup();
    await requestOtp(phone);
    const code = t.sms.lastCodeFor(phone);

    const [challenge] = await t.connection.db
      .select({ codeHash: schema.otpChallenges.codeHash })
      .from(schema.otpChallenges)
      .where(eq(schema.otpChallenges.phone, phone));
    expect(challenge?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(challenge?.codeHash).not.toContain(code);
  });

  it('locks the code after 5 wrong guesses, even if the 6th is right', async () => {
    const { phone } = await signup();
    await requestOtp(phone);
    const code = t.sms.lastCodeFor(phone);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await verifyOtp({ phone, code: wrong })).statusCode).toBe(401);
    }

    expect((await verifyOtp({ phone, code })).statusCode).toBe(401);
  });

  it('rejects an expired code', async () => {
    const { phone } = await signup();
    await requestOtp(phone);
    await t.connection.db
      .update(schema.otpChallenges)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(schema.otpChallenges.phone, phone));

    expect((await verifyOtp({ phone, code: t.sms.lastCodeFor(phone) })).statusCode).toBe(401);
  });

  it('accepts each code once, even when two requests race', async () => {
    const { phone } = await signup();
    await requestOtp(phone);
    const code = t.sms.lastCodeFor(phone);

    const results = await Promise.all([verifyOtp({ phone, code }), verifyOtp({ phone, code })]);
    const statuses = results.map((r) => r.statusCode).sort();

    expect(statuses).toEqual([200, 401]);
    expect((await verifyOtp({ phone, code })).statusCode).toBe(401);
  });

  describe('for someone who works for two businesses', () => {
    async function twoBusinesses() {
      const first = await signup({ organizationName: 'Alpha Paints' });
      const second = await signup({ organizationName: 'Beta Paints' });
      const [user] = await t.connection.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.phone, first.phone));
      await addMembership(t.connection, user?.id ?? '', {
        organizationId: second.grant.organizationId,
        roleKey: 'branch_manager',
      });
      await requestOtp(first.phone);
      return { phone: first.phone, code: t.sms.lastCodeFor(first.phone), second };
    }

    it('keeps the code while they choose, so they need not wait for a new one', async () => {
      const { phone, code, second } = await twoBusinesses();

      const choice = await verifyOtp({ phone, code });
      const chosen = await verifyOtp({ phone, code, organizationId: second.grant.organizationId });
      const reused = await verifyOtp({ phone, code, organizationId: second.grant.organizationId });

      expect(choice.statusCode).toBe(409);
      expect(
        choice.json<{ organizations: { name: string }[] }>().organizations.map((o) => o.name),
      ).toEqual(['Alpha Paints', 'Beta Paints']);
      expect(chosen.statusCode).toBe(200);
      expect(chosen.json<Grant>().organizationId).toBe(second.grant.organizationId);
      expect(reused.statusCode).toBe(401);
    });

    it('counts each answer without a choice as an attempt', async () => {
      const { phone, code, second } = await twoBusinesses();

      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await verifyOtp({ phone, code })).statusCode).toBe(409);
      }

      expect(
        (await verifyOtp({ phone, code, organizationId: second.grant.organizationId })).statusCode,
      ).toBe(401);
    });

    it('keeps the code when they choose a business they do not belong to', async () => {
      const { phone, code, second } = await twoBusinesses();
      const stranger = await signup();

      expect(
        (await verifyOtp({ phone, code, organizationId: stranger.grant.organizationId }))
          .statusCode,
      ).toBe(401);
      expect(
        (await verifyOtp({ phone, code, organizationId: second.grant.organizationId })).statusCode,
      ).toBe(200);
    });
  });

  it('rejects a code for a number that never requested one', async () => {
    expect((await verifyOtp({ phone: uniquePhone(), code: '123456' })).statusCode).toBe(401);
  });

  it('rejects the code if the person was deactivated after it was sent', async () => {
    const { phone } = await signup();
    await requestOtp(phone);
    await t.connection.db
      .update(schema.users)
      .set({ isActive: false })
      .where(eq(schema.users.phone, phone));

    expect((await verifyOtp({ phone, code: t.sms.lastCodeFor(phone) })).statusCode).toBe(401);
  });

  it('asks the person to wait 30 seconds between codes', async () => {
    const { phone } = await signup();
    expect((await requestOtp(phone)).statusCode).toBe(202);

    expect((await requestOtp(phone)).statusCode).toBe(429);
  });

  it('allows at most 5 codes per hour', async () => {
    const { phone } = await signup();
    for (let i = 0; i < 5; i++) {
      expect((await requestOtp(phone)).statusCode).toBe(202);
      // Pretend each code was requested a minute earlier, to get past the 30-second wait.
      await t.connection.db
        .update(schema.otpChallenges)
        .set({ createdAt: sql`created_at - interval '1 minute'` })
        .where(eq(schema.otpChallenges.phone, phone));
    }

    expect((await requestOtp(phone)).statusCode).toBe(429);
  });

  it('answers 503 when no SMS provider is configured', async () => {
    const withoutSms = await startTestApp(database.connectionString, {}, { fakeSms: false });
    try {
      const { phone } = await signup();

      const response = await withoutSms.app.inject({
        method: 'POST',
        url: '/auth/otp/request',
        payload: { phone },
      });

      expect(response.statusCode).toBe(503);
    } finally {
      await withoutSms.close();
    }
  });

  it('answers 400 for a code that is not 6 digits', async () => {
    expect((await verifyOtp({ phone: uniquePhone(), code: '12ab' })).statusCode).toBe(400);
  });
});
