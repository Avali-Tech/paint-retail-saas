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
  memberStores,
  organizationMembers,
  organizations,
  otpChallenges,
  rolePermissions,
  roles,
  sessions,
  stores,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;

async function failureMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const { message, cause } = error as Error;
    return `${message} ${cause instanceof Error ? cause.message : ''}`;
  }
  throw new Error('Expected the query to fail, but it succeeded');
}

interface Seed {
  orgA: string;
  orgB: string;
  storeA: string;
  storeB: string;
  roleA: string;
  roleB: string;
  shared: string;
  onlyA: string;
  onlyB: string;
  memberA: string;
}
let seed: Seed;

function first<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error('Expected a row');
  return row;
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

// Seeded outside tenant scope, as signup and onboarding will do.
beforeEach(async () => {
  const { db } = connection;
  for (const table of [
    otpChallenges,
    sessions,
    memberStores,
    organizationMembers,
    rolePermissions,
    roles,
    users,
    stores,
    organizations,
  ]) {
    await db.delete(table);
  }
  const orgA = first(await db.insert(organizations).values({ name: 'ABC Paints' }).returning()).id;
  const orgB = first(await db.insert(organizations).values({ name: 'XYZ Paints' }).returning()).id;
  const storeA = first(
    await db
      .insert(stores)
      .values({ organizationId: orgA, name: 'Hyderabad', code: 'HYD' })
      .returning(),
  ).id;
  const storeB = first(
    await db.insert(stores).values({ organizationId: orgB, name: 'Pune', code: 'PUN' }).returning(),
  ).id;
  const roleA = first(
    await db
      .insert(roles)
      .values({ organizationId: orgA, key: 'manager', name: 'Manager' })
      .returning(),
  ).id;
  const roleB = first(
    await db
      .insert(roles)
      .values({ organizationId: orgB, key: 'manager', name: 'Manager' })
      .returning(),
  ).id;
  await db.insert(rolePermissions).values([
    { organizationId: orgA, roleId: roleA, permission: 'stores:read' },
    { organizationId: orgB, roleId: roleB, permission: 'stores:read' },
    { organizationId: orgB, roleId: roleB, permission: 'stores:manage' },
  ]);
  const shared = first(
    await db.insert(users).values({ fullName: 'Raj Kumar', phone: '+919800000001' }).returning(),
  ).id;
  const onlyA = first(
    await db.insert(users).values({ fullName: 'Asha', email: 'asha@abc.in' }).returning(),
  ).id;
  const onlyB = first(
    await db.insert(users).values({ fullName: 'Bhavesh', phone: '+919800000002' }).returning(),
  ).id;
  const memberA = first(
    await db
      .insert(organizationMembers)
      .values({ organizationId: orgA, userId: shared, roleId: roleA })
      .returning(),
  ).id;
  await db.insert(organizationMembers).values([
    { organizationId: orgA, userId: onlyA, roleId: roleA, allStores: true },
    { organizationId: orgB, userId: shared, roleId: roleB },
    { organizationId: orgB, userId: onlyB, roleId: roleB },
  ]);
  await db
    .insert(memberStores)
    .values({ organizationId: orgA, memberId: memberA, storeId: storeA });
  const expiresAt = new Date(Date.now() + 60_000);
  await db.insert(sessions).values([
    { tokenHash: 'hash-a', userId: shared, organizationId: orgA, expiresAt },
    { tokenHash: 'hash-b', userId: shared, organizationId: orgB, expiresAt },
  ]);
  await db.insert(otpChallenges).values({ phone: '+919800000001', codeHash: 'x', expiresAt });
  seed = { orgA, orgB, storeA, storeB, roleA, roleB, shared, onlyA, onlyB, memberA };
});

describe('tenant isolation of identity data', () => {
  it('shows only people who belong to the current organisation', async () => {
    const seenByA = await withTenant(connection.db, seed.orgA, (tx) =>
      tx.select({ name: users.fullName }).from(users).orderBy(users.fullName),
    );
    const seenByB = await withTenant(connection.db, seed.orgB, (tx) =>
      tx.select({ name: users.fullName }).from(users).orderBy(users.fullName),
    );

    expect(seenByA.map((u) => u.name)).toEqual(['Asha', 'Raj Kumar']);
    expect(seenByB.map((u) => u.name)).toEqual(['Bhavesh', 'Raj Kumar']);
  });

  it('keeps roles, permissions, memberships, store access and sessions per organisation', async () => {
    const counts = (org: string) =>
      withTenant(connection.db, org, async (tx) => ({
        roles: (await tx.select().from(roles)).length,
        permissions: (await tx.select().from(rolePermissions)).length,
        members: (await tx.select().from(organizationMembers)).length,
        storeAccess: (await tx.select().from(memberStores)).length,
        sessions: (await tx.select().from(sessions)).length,
      }));

    expect(await counts(seed.orgA)).toEqual({
      roles: 1,
      permissions: 1,
      members: 2,
      storeAccess: 1,
      sessions: 1,
    });
    expect(await counts(seed.orgB)).toEqual({
      roles: 1,
      permissions: 2,
      members: 2,
      storeAccess: 0,
      sessions: 1,
    });
  });

  it('never lets a tenant read or create one-time sign-in codes', async () => {
    const visible = await withTenant(connection.db, seed.orgA, (tx) =>
      tx.select().from(otpChallenges),
    );
    const message = await failureMessage(
      withTenant(connection.db, seed.orgA, (tx) =>
        tx
          .insert(otpChallenges)
          .values({ phone: '+919800000009', codeHash: 'x', expiresAt: new Date() }),
      ),
    );

    expect(visible).toEqual([]);
    expect(message).toMatch(/row-level security/);
  });

  it('cannot add a member to another organisation', async () => {
    const message = await failureMessage(
      withTenant(connection.db, seed.orgA, (tx) =>
        tx
          .insert(organizationMembers)
          .values({ organizationId: seed.orgB, userId: seed.onlyA, roleId: seed.roleB }),
      ),
    );

    expect(message).toMatch(/row-level security/);
  });
});

describe('cross-organisation links are impossible, even outside tenant scope', () => {
  it('rejects giving a member a role from another organisation', async () => {
    const message = await failureMessage(
      connection.db
        .update(organizationMembers)
        .set({ roleId: seed.roleB })
        .where(eq(organizationMembers.id, seed.memberA)),
    );

    expect(message).toMatch(/organization_members_role_fk/);
  });

  it("rejects giving a member access to another organisation's store", async () => {
    const message = await failureMessage(
      connection.db
        .insert(memberStores)
        .values({ organizationId: seed.orgA, memberId: seed.memberA, storeId: seed.storeB }),
    );

    expect(message).toMatch(/member_stores_store_fk/);
  });

  it("rejects a permission row pointing at another organisation's role", async () => {
    const message = await failureMessage(
      connection.db
        .insert(rolePermissions)
        .values({ organizationId: seed.orgA, roleId: seed.roleB, permission: 'members:read' }),
    );

    expect(message).toMatch(/role_permissions_role_fk/);
  });
});

describe('user rules', () => {
  it.each([
    [{ fullName: 'No contact' }, /users_phone_or_email/],
    [{ fullName: 'Bad phone', phone: '9800000003' }, /users_phone_e164/],
    [{ fullName: 'Upper email', email: 'Asha@ABC.in' }, /users_email_lowercase/],
    [{ fullName: 'Duplicate phone', phone: '+919800000001' }, /users_phone_unique/],
    [{ fullName: 'Duplicate email', email: 'asha@abc.in' }, /users_email_unique/],
  ])('rejects %o', async (values, constraint) => {
    const message = await failureMessage(connection.db.insert(users).values(values));

    expect(message).toMatch(constraint);
  });

  it('allows the same person to belong to several organisations, but only once each', async () => {
    const message = await failureMessage(
      connection.db
        .insert(organizationMembers)
        .values({ organizationId: seed.orgA, userId: seed.shared, roleId: seed.roleA }),
    );

    expect(message).toMatch(/organization_members_organization_user_unique/);
  });
});

describe('clean-up rules', () => {
  it('deleting a role deletes its permissions; deleting a member deletes their store access', async () => {
    const { db } = connection;
    await db.delete(organizationMembers).where(eq(organizationMembers.roleId, seed.roleB));
    await db.delete(roles).where(eq(roles.id, seed.roleB));
    await db.delete(organizationMembers).where(eq(organizationMembers.id, seed.memberA));

    const permissionsOfB = await db
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, seed.roleB));
    const accessOfA = await db
      .select()
      .from(memberStores)
      .where(eq(memberStores.memberId, seed.memberA));

    expect(permissionsOfB).toEqual([]);
    expect(accessOfA).toEqual([]);
  });

  it('cannot delete a role that members still use', async () => {
    const message = await failureMessage(
      connection.db.delete(roles).where(eq(roles.id, seed.roleA)),
    );

    expect(message).toMatch(/organization_members_role_fk/);
  });
});
