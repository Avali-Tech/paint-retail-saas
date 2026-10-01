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
  loyaltyAccounts,
  loyaltyLedger,
  loyaltySettings,
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
let account: string;

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

const entry = (values: Partial<typeof loyaltyLedger.$inferInsert> = {}) =>
  connection.db
    .insert(loyaltyLedger)
    .values({
      organizationId: org,
      accountId: account,
      kind: 'award',
      points: 100,
      createdByMemberId: member,
      ...values,
    })
    .returning();

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
    await db.insert(users).values({ fullName: 'Owner', phone: '+919811100026' }).returning(),
  );
  member = id(
    await db
      .insert(organizationMembers)
      .values({ organizationId: org, userId: user, roleId: role })
      .returning(),
  );
  const party = id(
    await db
      .insert(parties)
      .values({ organizationId: org, displayName: 'Ravi Painter' })
      .returning(),
  );
  account = id(
    await db
      .insert(loyaltyAccounts)
      .values({ organizationId: org, partyId: party, createdByMemberId: member })
      .returning(),
  );
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('loyalty accounts', () => {
  it('start active, one per party, private to their business', async () => {
    const [row] = await connection.db
      .select()
      .from(loyaltyAccounts)
      .where(eq(loyaltyAccounts.id, account));

    expect(row?.status).toBe('active');
    expect(
      await failureMessage(
        connection.db.insert(loyaltyAccounts).values({
          organizationId: org,
          partyId: String(row?.partyId),
          createdByMemberId: member,
        }),
      ),
    ).toMatch(/loyalty_accounts_party_unique/);
    expect(
      await withTenant(connection.db, otherOrg, (tx) => tx.select().from(loyaltyAccounts)),
    ).toEqual([]);
  });
});

describe('the points ledger', () => {
  it.each([
    [{ points: 0 }, /loyalty_ledger_points_sign/],
    [{ kind: 'redeem' as const, points: 10 }, /loyalty_ledger_points_sign/],
    [
      { kind: 'expire' as const, points: 10, createdByMemberId: null },
      /loyalty_ledger_points_sign/,
    ],
    [{ kind: 'adjust' as const, points: 0, note: 'x' }, /loyalty_ledger_points_sign/],
    [{ kind: 'purchase' as const, reference: 'INV-1' }, /loyalty_ledger_purchase/],
    [{ manualPurchasePaise: 100 }, /loyalty_ledger_purchase/],
    [
      { kind: 'purchase' as const, manualPurchasePaise: 0, reference: 'INV-1' },
      /loyalty_ledger_purchase/,
    ],
    [{ kind: 'purchase' as const, manualPurchasePaise: 100 }, /loyalty_ledger_reference/],
    [{ kind: 'campaign' as const }, /loyalty_ledger_reference/],
    [{ kind: 'adjust' as const, points: 5 }, /loyalty_ledger_adjust_reason/],
    [
      { kind: 'redeem' as const, points: -5, expiresOn: '2027-01-01' },
      /loyalty_ledger_expiry_on_lots/,
    ],
    [{ kind: 'expire' as const, points: -5 }, /loyalty_ledger_system_expiry/],
    [{ createdByMemberId: null }, /loyalty_ledger_system_expiry/],
  ])('refuses inconsistent entries: %o', async (values, constraint) => {
    expect(await failureMessage(entry(values))).toMatch(constraint);
  });

  it('is append-only, whatever the role', async () => {
    const written = id(await entry());

    const change = connection.db
      .update(loyaltyLedger)
      .set({ points: 1_000 })
      .where(eq(loyaltyLedger.id, written));
    const remove = connection.db.delete(loyaltyLedger).where(eq(loyaltyLedger.id, written));
    // Started only when awaited, so its failure is never left unhandled.
    const asTenant = () =>
      withTenant(connection.db, org, (tx) =>
        tx.delete(loyaltyLedger).where(eq(loyaltyLedger.id, written)),
      );

    expect(await failureMessage(change)).toMatch(/loyalty_ledger is append-only/);
    expect(await failureMessage(remove)).toMatch(/loyalty_ledger is append-only/);
    expect(await failureMessage(asTenant())).toMatch(/permission denied/);
    expect(await failureMessage(connection.db.execute(sql`truncate loyalty_ledger`))).toMatch(
      /append-only/,
    );
  });

  it('audits adjustments only', async () => {
    await entry({ kind: 'adjust', points: -20, note: 'Duplicate award' });
    await entry({ kind: 'redeem', points: -10 });

    const entries = await connection.db
      .select({ newValues: auditLog.newValues })
      .from(auditLog)
      .where(sql`${auditLog.tableName} = 'loyalty_ledger' and ${auditLog.recordId} = ${account}`);
    expect(entries).toEqual([{ newValues: { points: -20, note: 'Duplicate award' } }]);
  });
});

describe('loyalty settings', () => {
  it('keep earning positive, expiry positive and tiers an array', async () => {
    const settings = (values: Partial<typeof loyaltySettings.$inferInsert>) =>
      connection.db.insert(loyaltySettings).values({ organizationId: otherOrg, ...values });

    expect(await failureMessage(settings({ earnPoints: 0 }))).toMatch(
      /loyalty_settings_earn_positive/,
    );
    expect(await failureMessage(settings({ earnPerPaise: 0 }))).toMatch(
      /loyalty_settings_earn_positive/,
    );
    expect(await failureMessage(settings({ expiryDays: 0 }))).toMatch(
      /loyalty_settings_expiry_positive/,
    );
    expect(await failureMessage(settings({ minRedemptionPoints: -1 }))).toMatch(
      /loyalty_settings_min_redemption/,
    );
    expect(
      await failureMessage(
        connection.db.execute(
          sql`insert into loyalty_settings (organization_id, tiers) values (${otherOrg}, '{}'::jsonb)`,
        ),
      ),
    ).toMatch(/loyalty_settings_tiers_array/);
    await settings({});
    const [saved] = await connection.db
      .select()
      .from(loyaltySettings)
      .where(eq(loyaltySettings.organizationId, otherOrg));
    expect(saved).toMatchObject({
      earnPoints: 1,
      earnPerPaise: 10_000,
      tiers: [],
      expiryDays: null,
      minRedemptionPoints: 0,
    });
  });
});
