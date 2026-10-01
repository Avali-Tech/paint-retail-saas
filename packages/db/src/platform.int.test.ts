import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

const {
  auditLog,
  organizations,
  platformAdmins,
  platformSessions,
  supportAccessLog,
  supportGrants,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let org: string;
let operator: string;

async function failureMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const { message, cause } = error as Error;
    return `${message} ${cause instanceof Error ? cause.message : ''}`;
  }
  throw new Error('Expected the query to fail, but it succeeded');
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  connection = createDatabase(database.connectionString);
  const [created] = await connection.db
    .insert(organizations)
    .values({ name: 'ABC Paints' })
    .returning();
  org = String(created?.id);
  const [user] = await connection.db
    .insert(users)
    .values({ fullName: 'Platform Support', email: 'support@paintsaas.example' })
    .returning();
  operator = String(user?.id);
  await connection.db.insert(platformAdmins).values({ userId: operator });
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('what a business may change about itself', () => {
  it('starts on the trial plan with no flags, and may rename itself', async () => {
    const [business] = await connection.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, org));
    await withTenant(connection.db, org, (tx) =>
      tx.update(organizations).set({ name: 'ABC Paints Pvt Ltd' }).where(eq(organizations.id, org)),
    );

    expect(business).toMatchObject({ plan: 'trial', featureFlags: {}, suspendedAt: null });
  });

  it.each([
    [{ plan: 'enterprise' as const }],
    [{ featureFlags: { loyalty: true } }],
    [{ suspendedAt: null, suspendReason: null }],
  ])('may not change its own plan, flags or suspension: %o', async (values) => {
    const attempt = withTenant(connection.db, org, (tx) =>
      tx.update(organizations).set(values).where(eq(organizations.id, org)),
    );

    expect(await failureMessage(attempt)).toMatch(/permission denied/);
  });

  it('needs a reason to be suspended', async () => {
    expect(
      await failureMessage(
        connection.db
          .update(organizations)
          .set({ suspendedAt: new Date() })
          .where(eq(organizations.id, org)),
      ),
    ).toMatch(/organizations_suspend_reason/);
  });
});

describe('platform tables', () => {
  it('are invisible to tenants', async () => {
    for (const table of [platformAdmins, platformSessions]) {
      expect(
        await failureMessage(withTenant(connection.db, org, (tx) => tx.select().from(table))),
      ).toMatch(/permission denied/);
    }
  });

  it('let tenants read and decide support requests, but not create them or write the access log', async () => {
    const [grant] = await connection.db
      .insert(supportGrants)
      .values({
        organizationId: org,
        platformUserId: operator,
        reason: 'Stock looks wrong',
        minutes: 60,
      })
      .returning();
    const seen = await withTenant(connection.db, org, (tx) => tx.select().from(supportGrants));
    const forged = withTenant(connection.db, org, (tx) =>
      tx
        .insert(supportGrants)
        .values({ organizationId: org, platformUserId: operator, reason: 'x', minutes: 60 }),
    );
    const logged = withTenant(connection.db, org, (tx) =>
      tx
        .insert(supportAccessLog)
        .values({ organizationId: org, grantId: String(grant?.id), method: 'GET', path: '/x' }),
    );

    expect(seen.map((g) => g.id)).toEqual([grant?.id]);
    expect(await failureMessage(forged)).toMatch(/permission denied/);
    expect(await failureMessage(logged)).toMatch(/permission denied/);
  });

  it.each([
    [{ minutes: 5 }, /support_grants_minutes_range/],
    [
      { approvedAt: new Date(), declinedAt: new Date(), expiresAt: new Date() },
      /support_grants_one_decision/,
    ],
    [{ approvedAt: new Date() }, /support_grants_expiry_when_approved/],
  ])('keep support grants consistent: %o', async (values, constraint) => {
    expect(
      await failureMessage(
        connection.db.insert(supportGrants).values({
          organizationId: org,
          platformUserId: operator,
          reason: 'Check',
          minutes: 60,
          ...values,
        }),
      ),
    ).toMatch(constraint);
  });
});

describe('audit', () => {
  it('records plan changes and support requests in the business’s own log', async () => {
    await connection.db
      .update(organizations)
      .set({ plan: 'standard' })
      .where(eq(organizations.id, org));

    const entries = await withTenant(connection.db, org, (tx) => tx.select().from(auditLog));

    expect(entries.map((e) => [e.tableName, e.action])).toEqual(
      expect.arrayContaining([
        ['organizations', 'update'],
        ['support_grants', 'insert'],
      ]),
    );
    expect(entries.find((e) => e.tableName === 'organizations')).toMatchObject({
      recordId: org,
      oldValues: { plan: 'trial' },
      newValues: { plan: 'standard' },
    });
  });
});
