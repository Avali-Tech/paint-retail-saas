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

const { auditLog, contracts, organizationMembers, organizations, parties, roles, users } = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let org: string;
let otherOrg: string;
let member: string;
let party: string;
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

const newContract = (values: Partial<typeof contracts.$inferInsert> = {}) => {
  seq += 1;
  return connection.db
    .insert(contracts)
    .values({
      organizationId: org,
      number: `CT-${String(seq)}`,
      type: 'contractor_agreement',
      title: 'Annual rate contract',
      partyId: party,
      startDate: '2026-04-01',
      endDate: '2027-03-31',
      renewalDate: '2027-03-01',
      assignedMemberId: member,
      createdByMemberId: member,
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
    await db.insert(users).values({ fullName: 'Owner', phone: '+919811100024' }).returning(),
  );
  member = id(
    await db
      .insert(organizationMembers)
      .values({ organizationId: org, userId: user, roleId: role })
      .returning(),
  );
  party = id(
    await db
      .insert(parties)
      .values({ organizationId: org, displayName: 'Raj Contractors' })
      .returning(),
  );
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('contracts', () => {
  it('start as drafts, private to their business', async () => {
    const [contract] = await newContract({ valuePaise: 25_00_000_00 });

    expect(contract).toMatchObject({ status: 'draft', valuePaise: 25_00_000_00, storeId: null });
    expect(await withTenant(connection.db, otherOrg, (tx) => tx.select().from(contracts))).toEqual(
      [],
    );
  });

  it.each([
    [{ endDate: '2026-03-31', renewalDate: '2026-03-01' }, /contracts_dates_in_order/],
    [{ renewalDate: '2027-04-01' }, /contracts_renewal_by_end/],
    [{ valuePaise: -1 }, /contracts_value_not_negative/],
    [{ status: 'terminated' as const, endedAt: new Date() }, /contracts_termination_reason/],
    [{ terminationReason: 'Stopped buying' }, /contracts_termination_reason/],
    [{ status: 'renewed' as const }, /contracts_ended_when_ended/],
  ])('refuses inconsistent values: %o', async (values, constraint) => {
    expect(await failureMessage(newContract(values))).toMatch(constraint);
  });

  it('links a renewal to the contract it renews, once, and never to itself', async () => {
    const first = id(await newContract());
    await newContract({ renewalOfId: first });

    expect(await failureMessage(newContract({ renewalOfId: first }))).toMatch(
      /contracts_renewal_of_unique/,
    );
    expect(
      await failureMessage(
        connection.db.update(contracts).set({ renewalOfId: first }).where(eq(contracts.id, first)),
      ),
    ).toMatch(/contracts_not_own_renewal/);
  });

  it('audits status, date and value changes, not notes', async () => {
    const contract = id(await newContract());
    await connection.db
      .update(contracts)
      .set({ status: 'active', valuePaise: 100, notes: 'Signed' })
      .where(eq(contracts.id, contract));
    await connection.db.update(contracts).set({ notes: 'Again' }).where(eq(contracts.id, contract));

    const entries = await connection.db
      .select({ action: auditLog.action, newValues: auditLog.newValues })
      .from(auditLog)
      .where(sql`${auditLog.tableName} = 'contracts' and ${auditLog.recordId} = ${contract}`)
      .orderBy(auditLog.id);

    expect(entries.map((entry) => entry.action)).toEqual(['insert', 'update']);
    expect(entries[1]?.newValues).toEqual({ status: 'active', value_paise: 100 });
  });
});
