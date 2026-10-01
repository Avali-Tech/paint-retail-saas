import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

const { activities, organizationMembers, organizations, roles, users } = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let org: string;
let otherOrg: string;
let member: string;

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

const newActivity = (values: Partial<typeof activities.$inferInsert> = {}) =>
  connection.db
    .insert(activities)
    .values({
      organizationId: org,
      recordType: 'lead',
      recordId: crypto.randomUUID(),
      type: 'follow_up',
      subject: 'Call back about the quotation',
      dueAt: new Date(),
      assignedMemberId: member,
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
    await db.insert(users).values({ fullName: 'Owner', phone: '+919811100006' }).returning(),
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

describe('activities', () => {
  it('can be scheduled or logged as done, privately to their business', async () => {
    const [scheduled] = await newActivity();
    const [logged] = await newActivity({ type: 'call', dueAt: null, completedAt: new Date() });

    expect(scheduled).toMatchObject({ completedAt: null, cancelledAt: null, remindedAt: null });
    expect(logged?.completedAt).toBeInstanceOf(Date);
    expect(await withTenant(connection.db, otherOrg, (tx) => tx.select().from(activities))).toEqual(
      [],
    );
  });

  it.each([
    [{ dueAt: null }, /activities_scheduled_or_done/],
    [{ completedAt: new Date(), cancelledAt: new Date() }, /activities_done_or_cancelled/],
  ])('refuses inconsistent values: %o', async (values, constraint) => {
    expect(await failureMessage(newActivity(values))).toMatch(constraint);
  });

  it('is assigned to a member of the same business', async () => {
    expect(await failureMessage(newActivity({ organizationId: otherOrg }))).toMatch(
      /activities_assigned_member_fk/,
    );
  });
});
