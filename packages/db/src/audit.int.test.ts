import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  postStockMovements,
  runAsMember,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

const {
  auditLog,
  brands,
  memberStores,
  organizationMembers,
  organizations,
  productVariants,
  products,
  rolePermissions,
  roles,
  stores,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let org: string;
let otherOrg: string;
let member: string;
let role: string;
let store: string;
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

/** Audit rows written since the last call. */
let seen = 0;
async function newEntries() {
  const rows = await connection.db.select().from(auditLog).orderBy(asc(auditLog.id));
  const fresh = rows.slice(seen);
  seen = rows.length;
  return fresh.map(({ tableName, recordId, action, actorMemberId, oldValues, newValues }) => ({
    tableName,
    recordId,
    action,
    actorMemberId,
    oldValues,
    newValues,
  }));
}

/** Does `work` as the member, in the organisation, as the API would. */
const asMember = <T>(work: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) =>
  runAsMember(member, () => withTenant(connection.db, org, work));

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  connection = createDatabase(database.connectionString);
  const { db } = connection;
  org = id(await db.insert(organizations).values({ name: 'ABC Paints' }).returning());
  otherOrg = id(await db.insert(organizations).values({ name: 'XYZ Paints' }).returning());
  role = id(
    await db.insert(roles).values({ organizationId: org, key: 'owner', name: 'Owner' }).returning(),
  );
  const user = id(
    await db.insert(users).values({ fullName: 'Owner', phone: '+919811100007' }).returning(),
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
  const brand = id(
    await db.insert(brands).values({ organizationId: org, name: 'Asian' }).returning(),
  );
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
      .values({
        organizationId: org,
        productId: product,
        sku: 'AP-1L',
        packSize: 1,
        unit: 'l',
        mrpPaise: 65_000,
        sellingPricePaise: 60_000,
      })
      .returning(),
  );
});

beforeEach(async () => {
  await newEntries();
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('what is audited', () => {
  it('records price changes with only the values that changed, and who made them', async () => {
    await asMember((tx) =>
      tx
        .update(productVariants)
        .set({ sellingPricePaise: 62_000 })
        .where(eq(productVariants.id, variant)),
    );
    await asMember((tx) =>
      tx.update(productVariants).set({ sku: 'AP-1L-NEW' }).where(eq(productVariants.id, variant)),
    );

    expect(await newEntries()).toEqual([
      {
        tableName: 'product_variants',
        recordId: variant,
        action: 'update',
        actorMemberId: member,
        oldValues: { selling_price_paise: 60_000 },
        newValues: { selling_price_paise: 62_000 },
      },
    ]);
  });

  it('records a variant being labelled, renamed or unlabelled, like a rename', async () => {
    const label = (value: string | null) =>
      asMember((tx) =>
        tx.update(productVariants).set({ label: value }).where(eq(productVariants.id, variant)),
      );
    await label('Red');
    await label('Deep Red');
    await label(null);

    const entry = (from: string | null, to: string | null) => ({
      tableName: 'product_variants',
      recordId: variant,
      action: 'update',
      actorMemberId: member,
      oldValues: { label: from },
      newValues: { label: to },
    });
    expect(await newEntries()).toEqual([
      entry(null, 'Red'),
      entry('Red', 'Deep Red'),
      entry('Deep Red', null),
    ]);
  });

  it('records roles, their permissions, and members’ access and stores', async () => {
    const custom = id(
      await asMember((tx) =>
        tx
          .insert(roles)
          .values({ organizationId: org, key: 'custom', name: 'Counter Staff' })
          .returning(),
      ),
    );
    await asMember(async (tx) => {
      await tx.update(roles).set({ name: 'Counter Team' }).where(eq(roles.id, custom));
      await tx
        .insert(rolePermissions)
        .values({ organizationId: org, roleId: custom, permission: 'catalog:read' });
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, custom));
      await tx
        .update(organizationMembers)
        .set({ allStores: true })
        .where(eq(organizationMembers.id, member));
      await tx
        .insert(memberStores)
        .values({ organizationId: org, memberId: member, storeId: store });
      await tx.delete(memberStores).where(eq(memberStores.memberId, member));
      await tx.delete(roles).where(eq(roles.id, custom));
    });

    expect(
      (await newEntries()).map((e) => [e.tableName, e.action, e.oldValues, e.newValues]),
    ).toEqual([
      ['roles', 'insert', null, { key: 'custom', name: 'Counter Staff' }],
      ['roles', 'update', { name: 'Counter Staff' }, { name: 'Counter Team' }],
      ['role_permissions', 'insert', null, { permission: 'catalog:read' }],
      ['role_permissions', 'delete', { permission: 'catalog:read' }, null],
      ['organization_members', 'update', { all_stores: false }, { all_stores: true }],
      ['member_stores', 'insert', null, { store_id: store }],
      ['member_stores', 'delete', { store_id: store }, null],
      ['roles', 'delete', { key: 'custom', name: 'Counter Team' }, null],
    ]);
  });

  it('records stock adjustments, damage and count corrections, but not ordinary movements', async () => {
    await asMember((tx) =>
      postStockMovements(tx, [
        {
          organizationId: org,
          storeId: store,
          variantId: variant,
          movementType: 'opening',
          quantity: 10,
        },
        {
          organizationId: org,
          storeId: store,
          variantId: variant,
          movementType: 'damage',
          quantity: -1,
          note: 'Dented',
        },
        {
          organizationId: org,
          storeId: store,
          variantId: variant,
          movementType: 'adjustment',
          quantity: 2,
          note: 'Found',
        },
      ]),
    );

    const entries = await newEntries();
    expect(entries.map((e) => [e.tableName, e.action, e.newValues])).toEqual([
      [
        'stock_ledger',
        'insert',
        {
          store_id: store,
          variant_id: variant,
          movement_type: 'damage',
          quantity: -1,
          note: 'Dented',
        },
      ],
      [
        'stock_ledger',
        'insert',
        {
          store_id: store,
          variant_id: variant,
          movement_type: 'adjustment',
          quantity: 2,
          note: 'Found',
        },
      ],
    ]);
  });

  it('records system work, done outside a member’s request, without an actor', async () => {
    await withTenant(connection.db, org, (tx) =>
      tx.update(productVariants).set({ mrpPaise: 70_000 }).where(eq(productVariants.id, variant)),
    );

    expect((await newEntries())[0]).toMatchObject({
      actorMemberId: null,
      newValues: { mrp_paise: 70_000 },
    });
  });
});

describe('the log itself', () => {
  it('can be read by the business it belongs to, and only by it', async () => {
    const own = await withTenant(connection.db, org, (tx) => tx.select().from(auditLog));
    const other = await withTenant(connection.db, otherOrg, (tx) => tx.select().from(auditLog));

    expect(own.length).toBeGreaterThan(0);
    expect(other).toEqual([]);
  });

  it('cannot be written, changed or removed by the application', async () => {
    const forged = withTenant(connection.db, org, (tx) =>
      tx
        .insert(auditLog)
        .values({ organizationId: org, tableName: 'x', recordId: 'x', action: 'update' }),
    );
    const edited = withTenant(connection.db, org, (tx) =>
      tx.update(auditLog).set({ recordId: 'y' }),
    );

    expect(await failureMessage(forged)).toMatch(/permission denied/);
    expect(await failureMessage(edited)).toMatch(/permission denied/);
  });

  it('cannot be changed or emptied even by the database owner', async () => {
    const results = await withPgClient(database.connectionString, async (client) => {
      const attempt = (statement: string) =>
        client.query(statement).then(
          () => 'ok',
          (error: unknown) => (error as Error).message,
        );
      return [
        await attempt("UPDATE audit_log SET record_id = 'y'"),
        await attempt('DELETE FROM audit_log'),
        await attempt('TRUNCATE audit_log'),
      ];
    });

    expect(results).toEqual([
      'audit_log is append-only',
      'audit_log is append-only',
      'audit_log is append-only',
    ]);
    expect(
      (await connection.db.execute(sql`select count(*)::int as n from audit_log`)).rows[0],
    ).not.toEqual({ n: 0 });
  });
});
