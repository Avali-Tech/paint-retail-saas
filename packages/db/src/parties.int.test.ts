import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

const {
  customerProfiles,
  organizationMembers,
  organizations,
  parties,
  partyRoles,
  roles,
  stores,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let orgA: string;
let orgB: string;
let storeA: string;
let storeB: string;
let memberB: string;
let rajA: string;

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

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  connection = createDatabase(database.connectionString);
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

beforeEach(async () => {
  const { db } = connection;
  for (const table of [
    customerProfiles,
    partyRoles,
    parties,
    organizationMembers,
    roles,
    users,
    stores,
    organizations,
  ]) {
    await db.delete(table);
  }
  orgA = id(await db.insert(organizations).values({ name: 'ABC Paints' }).returning());
  orgB = id(await db.insert(organizations).values({ name: 'XYZ Paints' }).returning());
  storeA = id(
    await db.insert(stores).values({ organizationId: orgA, name: 'HYD', code: 'HYD' }).returning(),
  );
  storeB = id(
    await db.insert(stores).values({ organizationId: orgB, name: 'PUN', code: 'PUN' }).returning(),
  );
  const roleB = id(
    await db
      .insert(roles)
      .values({ organizationId: orgB, key: 'sales', name: 'Sales' })
      .returning(),
  );
  const userB = id(
    await db.insert(users).values({ fullName: 'Seller', phone: '+919811111111' }).returning(),
  );
  memberB = id(
    await db
      .insert(organizationMembers)
      .values({ organizationId: orgB, userId: userB, roleId: roleB })
      .returning(),
  );
  rajA = id(
    await db
      .insert(parties)
      .values({
        organizationId: orgA,
        displayName: 'Raj Kumar',
        phone: '+919822222222',
        homeStoreId: storeA,
      })
      .returning(),
  );
  await db.insert(partyRoles).values([
    { organizationId: orgA, partyId: rajA, role: 'customer' },
    { organizationId: orgA, partyId: rajA, role: 'contractor' },
  ]);
  await db
    .insert(customerProfiles)
    .values({ organizationId: orgA, partyId: rajA, customerType: 'contractor' });
  await db.insert(parties).values({ organizationId: orgB, displayName: 'Other Business Customer' });
});

describe('parties: tenant isolation', () => {
  it('keeps parties, their roles and customer profiles inside their business', async () => {
    const seen = (org: string) =>
      withTenant(connection.db, org, async (tx) => ({
        parties: (await tx.select({ name: parties.displayName }).from(parties)).map((p) => p.name),
        roles: (await tx.select().from(partyRoles)).length,
        profiles: (await tx.select().from(customerProfiles)).length,
      }));

    expect(await seen(orgA)).toEqual({ parties: ['Raj Kumar'], roles: 2, profiles: 1 });
    expect(await seen(orgB)).toEqual({
      parties: ['Other Business Customer'],
      roles: 0,
      profiles: 0,
    });
  });

  it('cannot create a party in another business', async () => {
    const message = await failureMessage(
      withTenant(connection.db, orgA, (tx) =>
        tx.insert(parties).values({ organizationId: orgB, displayName: 'Sneaky' }),
      ),
    );

    expect(message).toMatch(/row-level security/);
  });
});

describe('parties: integrity', () => {
  it('allows one party per mobile number and per GSTIN in a business, but the same in another business', async () => {
    const { db } = connection;
    const phone = '+919833333333';
    await db
      .insert(parties)
      .values({ organizationId: orgA, displayName: 'First', phone, gstin: '27AAPFU0939F1ZV' });
    await db
      .insert(parties)
      .values({ organizationId: orgB, displayName: 'Elsewhere', phone, gstin: '27AAPFU0939F1ZV' });

    const duplicatePhone = await failureMessage(
      db.insert(parties).values({ organizationId: orgA, displayName: 'Second', phone }),
    );
    const duplicateGstin = await failureMessage(
      db
        .insert(parties)
        .values({ organizationId: orgA, displayName: 'Third', gstin: '27AAPFU0939F1ZV' }),
    );

    expect(duplicatePhone).toMatch(/parties_organization_phone_unique/);
    expect(duplicateGstin).toMatch(/parties_organization_gstin_unique/);
  });

  it('allows any number of parties without a phone or GSTIN', async () => {
    await connection.db.insert(parties).values([
      { organizationId: orgA, displayName: 'Walk-in 1' },
      { organizationId: orgA, displayName: 'Walk-in 2' },
    ]);

    const count = await connection.db
      .select()
      .from(parties)
      .where(eq(parties.organizationId, orgA));
    expect(count).toHaveLength(3);
  });

  it.each([
    [{ phone: '9822222223' }, /parties_phone_e164/],
    [{ alternatePhone: '12345' }, /parties_alternate_phone_e164/],
    [{ email: 'Raj@ABC.in' }, /parties_email_lowercase/],
    [{ gstin: '27aapfu0939f1zv' }, /parties_gstin_format/],
    [{ pan: 'AAPF0939F' }, /parties_pan_format/],
    [{ pincode: '050081' }, /parties_pincode_format/],
  ])('rejects %o', async (values, constraint) => {
    const message = await failureMessage(
      connection.db.insert(parties).values({ organizationId: orgA, displayName: 'Bad', ...values }),
    );

    expect(message).toMatch(constraint);
  });

  it('rejects a home store or salesperson from another business', async () => {
    const store = await failureMessage(
      connection.db
        .insert(parties)
        .values({ organizationId: orgA, displayName: 'X', homeStoreId: storeB }),
    );
    const salesperson = await failureMessage(
      connection.db
        .update(customerProfiles)
        .set({ assignedMemberId: memberB })
        .where(eq(customerProfiles.partyId, rajA)),
    );

    expect(store).toMatch(/parties_home_store_fk/);
    expect(salesperson).toMatch(/customer_profiles_assigned_member_fk/);
  });

  it('removes roles and the customer profile with the party', async () => {
    await connection.db.delete(parties).where(eq(parties.id, rajA));

    expect(
      await connection.db.select().from(partyRoles).where(eq(partyRoles.partyId, rajA)),
    ).toEqual([]);
    expect(
      await connection.db.select().from(customerProfiles).where(eq(customerProfiles.partyId, rajA)),
    ).toEqual([]);
  });

  it('cannot give a party the same role twice', async () => {
    const message = await failureMessage(
      connection.db
        .insert(partyRoles)
        .values({ organizationId: orgA, partyId: rajA, role: 'customer' }),
    );

    expect(message).toMatch(/party_roles_pkey|duplicate key/);
  });
});
