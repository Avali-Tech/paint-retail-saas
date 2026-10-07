import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  runAsMember,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

const {
  auditLog,
  organizationMembers,
  organizations,
  parties,
  roles,
  stores,
  taxCategories,
  taxRates,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let orgA: string;
let orgB: string;
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

/** The id of a business's default category with `key`. */
async function category(organizationId: string, key: string): Promise<string> {
  return id(
    await connection.db
      .select({ id: taxCategories.id })
      .from(taxCategories)
      .where(and(eq(taxCategories.organizationId, organizationId), eq(taxCategories.key, key))),
  );
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  connection = createDatabase(database.connectionString);
  const { db } = connection;
  orgA = id(await db.insert(organizations).values({ name: 'ABC Paints' }).returning());
  orgB = id(await db.insert(organizations).values({ name: 'XYZ Paints' }).returning());
  const role = id(
    await db
      .insert(roles)
      .values({ organizationId: orgA, key: 'owner', name: 'Owner' })
      .returning(),
  );
  const user = id(
    await db.insert(users).values({ fullName: 'Owner', phone: '+919811100071' }).returning(),
  );
  member = id(
    await db
      .insert(organizationMembers)
      .values({ organizationId: orgA, userId: user, roleId: role })
      .returning(),
  );
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('default tax categories', () => {
  it('gives every new business the defaults, 18% from 22 September 2025 and one default', async () => {
    const rows = await withTenant(connection.db, orgA, (tx) =>
      tx
        .select({
          key: taxCategories.key,
          name: taxCategories.name,
          isDefault: taxCategories.isDefault,
          rateBps: taxRates.rateBps,
          effectiveFrom: taxRates.effectiveFrom,
          effectiveTo: taxRates.effectiveTo,
        })
        .from(taxCategories)
        .innerJoin(taxRates, eq(taxRates.taxCategoryId, taxCategories.id))
        .orderBy(asc(taxCategories.name)),
    );
    expect(rows).toEqual([
      expect.objectContaining({ key: 'brushes_rollers', name: 'Brushes & rollers 18%' }),
      expect.objectContaining({ key: 'exempt', name: 'Exempt', rateBps: 0 }),
      expect.objectContaining({ key: 'paints', name: 'Paints 18%', isDefault: true }),
      expect.objectContaining({ key: 'putty', name: 'Putty & fillers 18%' }),
      expect.objectContaining({ key: 'tools', name: 'Tools 18%' }),
      expect.objectContaining({ key: 'varnishes', name: 'Varnishes & wood finishes 18%' }),
    ]);
    expect(rows.filter((row) => row.isDefault)).toHaveLength(1);
    expect(
      rows.every((row) => row.effectiveFrom === '2025-09-22' && row.effectiveTo === null),
    ).toBe(true);
    expect(rows.filter((row) => row.rateBps === 1800)).toHaveLength(5);
  });

  it('keeps each business to its own categories and rates', async () => {
    const seen = await withTenant(connection.db, orgA, async (tx) => ({
      categories: await tx.select().from(taxCategories),
      rates: await tx.select().from(taxRates),
    }));
    expect(seen.categories.every((row) => row.organizationId === orgA)).toBe(true);
    expect(seen.rates.every((row) => row.organizationId === orgA)).toBe(true);

    const foreign = await category(orgB, 'paints');
    const message = await failureMessage(
      withTenant(connection.db, orgA, (tx) =>
        tx.insert(taxRates).values({
          organizationId: orgB,
          taxCategoryId: foreign,
          rateBps: 500,
          effectiveFrom: '2030-01-01',
        }),
      ),
    );
    expect(message).toMatch(/row-level security/);
  });

  it('allows one default category per business', async () => {
    const message = await failureMessage(
      connection.db
        .insert(taxCategories)
        .values({ organizationId: orgA, name: 'Second default', isDefault: true }),
    );
    expect(message).toMatch(/tax_categories_one_default/);
  });
});

describe('rate history', () => {
  it('refuses overlapping periods for one category', async () => {
    const paints = await category(orgA, 'paints');
    const message = await failureMessage(
      connection.db.insert(taxRates).values({
        organizationId: orgA,
        taxCategoryId: paints,
        rateBps: 500,
        effectiveFrom: '2030-01-01',
      }),
    );
    expect(message).toMatch(/tax_rates_no_overlap/);
  });

  it('lets a tenant close the open period once, and never edit or delete a rate', async () => {
    const tools = await category(orgA, 'tools');
    const open = and(eq(taxRates.taxCategoryId, tools), isNull(taxRates.effectiveTo));

    await withTenant(connection.db, orgA, (tx) =>
      tx.update(taxRates).set({ effectiveTo: '2030-03-31' }).where(open),
    );
    const closed = and(eq(taxRates.taxCategoryId, tools), eq(taxRates.effectiveFrom, '2025-09-22'));
    expect(
      await failureMessage(
        withTenant(connection.db, orgA, (tx) =>
          tx.update(taxRates).set({ effectiveTo: '2030-06-30' }).where(closed),
        ),
      ),
    ).toMatch(/never changed/);
    expect(
      await failureMessage(
        withTenant(connection.db, orgA, (tx) =>
          tx.update(taxRates).set({ rateBps: 500 }).where(closed),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await failureMessage(
        withTenant(connection.db, orgA, (tx) => tx.delete(taxRates).where(closed)),
      ),
    ).toMatch(/permission denied/);
    expect(
      await failureMessage(
        withTenant(connection.db, orgA, (tx) =>
          tx.delete(taxCategories).where(eq(taxCategories.id, tools)),
        ),
      ),
    ).toMatch(/permission denied/);
    // Even the owner of the tables cannot rewrite a rate.
    expect(
      await failureMessage(connection.db.update(taxRates).set({ rateBps: 500 }).where(closed)),
    ).toMatch(/never changed/);
  });

  it('leaves the defaults a business starts with out of the audit log', async () => {
    const entries = await connection.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.organizationId, orgB));
    expect(entries).toEqual([]);
  });

  it('records categories and rates in the audit log, with who changed them', async () => {
    const putty = await category(orgA, 'putty');
    await runAsMember(member, () =>
      withTenant(connection.db, orgA, async (tx) => {
        await tx
          .update(taxCategories)
          .set({ name: 'Putty 18%' })
          .where(eq(taxCategories.id, putty));
        await tx
          .update(taxRates)
          .set({ effectiveTo: '2031-01-31' })
          .where(and(eq(taxRates.taxCategoryId, putty), isNull(taxRates.effectiveTo)));
      }),
    );
    const entries = await connection.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorMemberId, member)))
      .orderBy(asc(auditLog.id));
    expect(
      entries.map(({ tableName, action, newValues }) => ({ tableName, action, newValues })),
    ).toEqual([
      { tableName: 'tax_categories', action: 'update', newValues: { name: 'Putty 18%' } },
      { tableName: 'tax_rates', action: 'update', newValues: { effective_to: '2031-01-31' } },
    ]);
  });
});

describe('stores and parties', () => {
  it('checks a store registration: GSTIN in its state, complete when registered', async () => {
    const base = {
      organizationId: orgA,
      name: 'Ameerpet',
      code: `AMP${String(Date.now() % 1000)}`,
    };
    expect(
      await failureMessage(
        connection.db.insert(stores).values({ ...base, gstin: '36AABCS1429B1ZV', stateCode: '37' }),
      ),
    ).toMatch(/stores_gstin_in_state/);
    expect(
      await failureMessage(
        connection.db
          .insert(stores)
          .values({ ...base, registrationType: 'regular', stateCode: '36' }),
      ),
    ).toMatch(/stores_registration_complete/);
    // What the previous release wrote: a bare GSTIN, still unregistered.
    await connection.db.insert(stores).values({ ...base, gstin: '36AABCS1429B1ZV' });
  });

  it("sets a party's place of supply from its GSTIN, and keeps it otherwise", async () => {
    const [party] = await connection.db
      .insert(parties)
      .values({
        organizationId: orgA,
        displayName: 'Vizag Builders',
        gstin: '37AABCS1429B1ZT',
        placeOfSupply: '36',
      })
      .returning();
    expect(party?.placeOfSupply).toBe('37');
    const [updated] = await connection.db
      .update(parties)
      .set({ gstin: null, placeOfSupply: '36' })
      .where(eq(parties.id, String(party?.id)))
      .returning();
    expect(updated?.placeOfSupply).toBe('36');
    expect(
      await failureMessage(
        connection.db
          .update(parties)
          .set({ placeOfSupply: '3' })
          .where(eq(parties.id, String(party?.id))),
      ),
    ).toMatch(/parties_place_of_supply_format/);
  });

  it('removes a business together with its tax categories (platform clean-up only)', async () => {
    const [org] = await connection.db.insert(organizations).values({ name: 'Gone' }).returning();
    await connection.db.delete(organizations).where(eq(organizations.id, String(org?.id)));
    const [left] = await connection.db
      .select({ count: sql<number>`count(*)::int` })
      .from(taxCategories)
      .where(eq(taxCategories.organizationId, String(org?.id)));
    expect(left?.count).toBe(0);
  });
});
