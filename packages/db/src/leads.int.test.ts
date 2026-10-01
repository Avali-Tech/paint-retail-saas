import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

const { leads, opportunities, organizationMembers, organizations, parties, roles, stores, users } =
  schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let org: string;
let otherOrg: string;
let member: string;
let store: string;
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

const newLead = (values: Partial<typeof leads.$inferInsert> = {}) => {
  seq += 1;
  return connection.db
    .insert(leads)
    .values({
      organizationId: org,
      number: `LD-${String(seq)}`,
      storeId: store,
      partyId: party,
      title: '4-floor building',
      source: 'phone_call',
      createdByMemberId: member,
      ...values,
    })
    .returning();
};

const newOpportunity = (values: Partial<typeof opportunities.$inferInsert> = {}) => {
  seq += 1;
  return connection.db
    .insert(opportunities)
    .values({
      organizationId: org,
      number: `OP-${String(seq)}`,
      storeId: store,
      partyId: party,
      title: 'Gachibowli apartments',
      expectedValuePaise: 85_000_000,
      probability: 25,
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
    await db.insert(users).values({ fullName: 'Owner', phone: '+919811100004' }).returning(),
  );
  member = id(
    await db
      .insert(organizationMembers)
      .values({ organizationId: org, userId: user, roleId: role })
      .returning(),
  );
  store = id(
    await db.insert(stores).values({ organizationId: org, name: 'HYD', code: 'HYD' }).returning(),
  );
  party = id(
    await db
      .insert(parties)
      .values({ organizationId: org, displayName: 'Sharma Builders' })
      .returning(),
  );
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('leads', () => {
  it('start new, open, and private to their business', async () => {
    const [lead] = await newLead();

    expect(lead).toMatchObject({ stage: 'new', closedAt: null, lostReason: null });
    expect(await withTenant(connection.db, otherOrg, (tx) => tx.select().from(leads))).toEqual([]);
  });

  it.each([
    [{ stage: 'lost' as const, closedAt: new Date() }, /leads_lost_reason/],
    [{ lostReason: 'Too costly' }, /leads_lost_reason/],
    [{ stage: 'won' as const }, /leads_closed_when_closed/],
    [{ closedAt: new Date() }, /leads_closed_when_closed/],
    [{ estimatedValuePaise: -1 }, /leads_value_not_negative/],
    [
      { organizationId: '00000000-0000-4000-8000-000000000000' },
      /leads_store_fk|row-level|violates/,
    ],
  ])('refuses inconsistent values: %o', async (values, constraint) => {
    expect(await failureMessage(newLead(values))).toMatch(constraint);
  });

  it('accepts a lost lead with its reason, and keeps numbers unique', async () => {
    const [lost] = await newLead({
      stage: 'lost',
      lostReason: 'Chose another dealer',
      closedAt: new Date(),
    });

    expect(lost?.stage).toBe('lost');
    await newLead({ number: 'LD-DUP' });
    expect(await failureMessage(newLead({ number: 'LD-DUP' }))).toMatch(
      /leads_organization_number_unique/,
    );
  });
});

describe('opportunities', () => {
  it.each([
    [{ probability: 101 }, /opportunities_probability_range/],
    [{ probability: -1 }, /opportunities_probability_range/],
    [{ expectedValuePaise: -1 }, /opportunities_value_not_negative/],
    [{ expectedQuantity: 0 }, /opportunities_quantity_positive/],
    [{ stage: 'lost' as const, closedAt: new Date() }, /opportunities_lost_reason/],
    [{ stage: 'won' as const }, /opportunities_closed_when_closed/],
  ])('refuses inconsistent values: %o', async (values, constraint) => {
    expect(await failureMessage(newOpportunity(values))).toMatch(constraint);
  });

  it('comes from at most one lead each', async () => {
    const [lead] = await newLead({ stage: 'opportunity' });
    const [opportunity] = await newOpportunity({ leadId: lead?.id, expectedQuantity: 120.5 });

    expect(opportunity).toMatchObject({ stage: 'discovery', expectedQuantity: 120.5 });
    expect(await failureMessage(newOpportunity({ leadId: lead?.id }))).toMatch(
      /opportunities_lead_unique/,
    );
  });
});
