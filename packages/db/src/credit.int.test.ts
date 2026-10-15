import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
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
  creditProfiles,
  creditRequests,
  creditRules,
  organizationMembers,
  organizations,
  parties,
  roles,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let org: string;
let otherOrg: string;
let member: string;
let seq = 0;

async function failureMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const { message, cause } = error as Error;
    return `${message} ${cause instanceof Error ? cause.message : ''}`;
  }
  throw new Error('Expected the query to fail, but it succeeded');
}

function id(rows: { id: string }[]): string {
  const [row] = rows;
  if (!row) throw new Error('Expected a row');
  return row.id;
}

async function newParty(): Promise<string> {
  seq += 1;
  return id(
    await connection.db
      .insert(parties)
      .values({ organizationId: org, displayName: `Contractor ${String(seq)}` })
      .returning(),
  );
}

const newProfile = async (values: Partial<typeof creditProfiles.$inferInsert> = {}) =>
  connection.db
    .insert(creditProfiles)
    .values({ organizationId: org, partyId: await newParty(), ...values })
    .returning();

const newRequest = async (
  partyId: string,
  values: Partial<typeof creditRequests.$inferInsert> = {},
) => {
  seq += 1;
  return connection.db
    .insert(creditRequests)
    .values({
      organizationId: org,
      number: `CR-${String(seq)}`,
      partyId,
      limitPaise: 30_000_00,
      creditDays: 30,
      previousLimitPaise: 0,
      previousCreditDays: 0,
      requestedByMemberId: member,
      ...values,
    })
    .returning();
};

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  connection = createDatabase(database.connectionString);
  const { db } = connection;
  org = id(await db.insert(organizations).values({ name: 'ABC Paints' }).returning());
  otherOrg = id(await db.insert(organizations).values({ name: 'XYZ Paints' }).returning());
  const role = id(
    await db.insert(roles).values({ organizationId: org, key: 'owner', name: 'Owner' }).returning(),
  );
  const user = id(
    await db.insert(users).values({ fullName: 'Owner', phone: '+919811100025' }).returning(),
  );
  member = id(
    await db
      .insert(organizationMembers)
      .values({ organizationId: org, userId: user, roleId: role })
      .returning(),
  );
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('credit profiles', () => {
  it('start without credit, private to their business', async () => {
    const [profile] = await newProfile();

    expect(profile).toMatchObject({ status: 'none', limitPaise: 0, risk: 'low' });
    expect(
      await withTenant(connection.db, otherOrg, (tx) => tx.select().from(creditProfiles)),
    ).toEqual([]);
  });

  it.each([
    [{ limitPaise: -1 }, /credit_profiles_limit_not_negative/],
    [{ creditDays: 366 }, /credit_profiles_days_range/],
    [{ manualExposurePaise: -1 }, /credit_profiles_exposure_not_negative/],
    [{ overdueDays: -1 }, /credit_profiles_overdue_not_negative/],
    [{ status: 'active' as const }, /credit_profiles_limit_when_enabled/],
    [{ status: 'on_hold' as const, limitPaise: 100 }, /credit_profiles_hold_reason/],
    [{ heldAt: new Date() }, /credit_profiles_hold_complete/],
    [
      { status: 'active' as const, limitPaise: 100, holdReason: 'x' },
      /credit_profiles_hold_(complete|reason)/,
    ],
  ])('refuses inconsistent values: %o', async (values, constraint) => {
    expect(await failureMessage(newProfile(values))).toMatch(constraint);
  });

  it('are one per party, and audited for limit, days, status and hold', async () => {
    const [profile] = await newProfile({ status: 'active', limitPaise: 100, creditDays: 7 });
    const partyId = String(profile?.partyId);
    expect(
      await failureMessage(
        connection.db.insert(creditProfiles).values({ organizationId: org, partyId }),
      ),
    ).toMatch(/credit_profiles_party_unique/);
    await connection.db
      .update(creditProfiles)
      .set({ limitPaise: 200, risk: 'high', manualExposurePaise: 50 })
      .where(eq(creditProfiles.partyId, partyId));

    const entries = await connection.db
      .select({ action: auditLog.action, newValues: auditLog.newValues })
      .from(auditLog)
      .where(
        sql`${auditLog.tableName} = 'credit_profiles' and ${auditLog.recordId} = ${String(profile?.id)}`,
      )
      .orderBy(auditLog.id);
    expect(entries).toEqual([
      {
        action: 'insert',
        newValues: {
          status: 'active',
          limit_paise: 100,
          credit_days: 7,
          hold_reason: null,
          opening_overdue_since: null,
          // MVP 3 (P2-M09): who held it, and how long an overdue block is waived.
          hold_kind: null,
          overdue_waived_until: null,
        },
      },
      { action: 'update', newValues: { limit_paise: 200 } },
    ]);
  });
});

describe('credit requests', () => {
  it('allow one pending request per party', async () => {
    const party = await newParty();
    await newRequest(party);
    await newRequest(party, {
      status: 'rejected',
      decidedAt: new Date(),
      decidedByMemberId: member,
      decisionNote: 'No',
    });

    expect(await failureMessage(newRequest(party))).toMatch(
      /credit_requests_one_pending_per_party/,
    );
  });

  it.each([
    [{ limitPaise: 0 }, /credit_requests_limit_positive/],
    [{ creditDays: -1 }, /credit_requests_days_range/],
    [{ status: 'approved' as const }, /credit_requests_decided_when_decided/],
    [{ decidedAt: new Date(), decidedByMemberId: member }, /credit_requests_decided_when_decided/],
    [
      { status: 'rejected' as const, decidedAt: new Date(), decidedByMemberId: member },
      /credit_requests_rejection_note/,
    ],
  ])('refuses inconsistent values: %o', async (values, constraint) => {
    expect(await failureMessage(newRequest(await newParty(), values))).toMatch(constraint);
  });
});

describe('credit rules', () => {
  it('keep the thresholds in order and the hold days positive', async () => {
    const rules = (values: Partial<typeof creditRules.$inferInsert>) =>
      connection.db.insert(creditRules).values({ organizationId: otherOrg, ...values });

    expect(await failureMessage(rules({ normalUpToPercent: 90, managerUpToPercent: 80 }))).toMatch(
      /credit_rules_percent_order/,
    );
    expect(await failureMessage(rules({ managerUpToPercent: 1001 }))).toMatch(
      /credit_rules_percent_order/,
    );
    expect(await failureMessage(rules({ holdAfterOverdueDays: 0 }))).toMatch(
      /credit_rules_hold_days_positive/,
    );
    await rules({});
    const [saved] = await connection.db
      .select()
      .from(creditRules)
      .where(eq(creditRules.organizationId, otherOrg));
    expect(saved).toMatchObject({
      normalUpToPercent: 80,
      managerUpToPercent: 100,
      holdAfterOverdueDays: 30,
    });
  });
});
