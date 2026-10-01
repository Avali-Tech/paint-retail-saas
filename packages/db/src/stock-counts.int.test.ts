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
  brands,
  organizationMembers,
  organizations,
  productVariants,
  products,
  roles,
  stockCountLines,
  stockCounts,
  stores,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let org: string;
let otherOrg: string;
let member: string;
let brand: string;
let variant: string;

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

let n = 0;
async function newStore(): Promise<string> {
  n += 1;
  return id(
    await connection.db
      .insert(stores)
      .values({ organizationId: org, name: `Store ${String(n)}`, code: `S${String(n)}X` })
      .returning(),
  );
}

const newCount = (storeId: string, values: Partial<typeof stockCounts.$inferInsert> = {}) =>
  connection.db
    .insert(stockCounts)
    .values({
      organizationId: org,
      number: `SC-${String(Math.random()).slice(2, 10)}`,
      storeId,
      scope: 'full',
      startedByMemberId: member,
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
    await db.insert(users).values({ fullName: 'Owner', phone: '+919822200000' }).returning(),
  );
  member = id(
    await db
      .insert(organizationMembers)
      .values({ organizationId: org, userId: user, roleId: role })
      .returning(),
  );
  brand = id(await db.insert(brands).values({ organizationId: org, name: 'Asian' }).returning());
  const product = id(
    await db
      .insert(products)
      .values({
        organizationId: org,
        brandId: brand,
        name: 'Apex',
        type: 'exterior_paint',
        hsnCode: '3209',
        gstRateBps: 1800,
      })
      .returning(),
  );
  variant = id(
    await db
      .insert(productVariants)
      .values({ organizationId: org, productId: product, sku: 'AP-1L', packSize: 1, unit: 'l' })
      .returning(),
  );
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('stock counts', () => {
  it('allows one open count per store, and a new one once it is closed', async () => {
    const store = await newStore();
    const first = id(await newCount(store));

    const second = await failureMessage(newCount(store));
    expect(second).toMatch(/stock_counts_one_open_per_store/);

    await connection.db
      .update(stockCounts)
      .set({ status: 'approved' })
      .where(eq(stockCounts.id, first));
    expect(id(await newCount(store))).toBeTruthy();
  });

  it('counts different stores at the same time', async () => {
    expect(id(await newCount(await newStore()))).toBeTruthy();
    expect(id(await newCount(await newStore()))).toBeTruthy();
  });

  it('needs a brand or category id exactly when the count is partial', async () => {
    const store = await newStore();

    expect(await failureMessage(newCount(store, { scope: 'brand' }))).toMatch(
      /stock_counts_scope_id_matches_scope/,
    );
    expect(await failureMessage(newCount(store, { scope: 'full', scopeId: brand }))).toMatch(
      /stock_counts_scope_id_matches_scope/,
    );
    expect(id(await newCount(store, { scope: 'brand', scopeId: brand }))).toBeTruthy();
  });

  it('refuses negative quantities and removes lines with the count', async () => {
    const count = id(await newCount(await newStore()));
    const line = { organizationId: org, countId: count, variantId: variant };

    expect(
      await failureMessage(
        connection.db.insert(stockCountLines).values({ ...line, expectedQuantity: -1 }),
      ),
    ).toMatch(/stock_count_lines_expected_not_negative/);
    expect(
      await failureMessage(
        connection.db
          .insert(stockCountLines)
          .values({ ...line, expectedQuantity: 1, countedQuantity: -1 }),
      ),
    ).toMatch(/stock_count_lines_counted_not_negative/);

    await connection.db
      .insert(stockCountLines)
      .values({ ...line, expectedQuantity: 3, countedQuantity: 2 });
    await connection.db.delete(stockCounts).where(eq(stockCounts.id, count));
    expect(
      await connection.db.select().from(stockCountLines).where(eq(stockCountLines.countId, count)),
    ).toEqual([]);
  });

  it('keeps counts inside their business', async () => {
    await newCount(await newStore());

    expect(
      await withTenant(connection.db, otherOrg, (tx) => tx.select().from(stockCounts)),
    ).toEqual([]);
  });
});
