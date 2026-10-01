import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  nextDocumentNumber,
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
  stores,
  transferLines,
  transfers,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let org: string;
let otherOrg: string;
let hyd: string;
let pune: string;
let member: string;
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

const number = (organizationId: string, series: string) =>
  withTenant(connection.db, organizationId, (tx) => nextDocumentNumber(tx, organizationId, series));

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  connection = createDatabase(database.connectionString);
  const { db } = connection;
  org = id(await db.insert(organizations).values({ name: 'ABC Paints' }).returning());
  otherOrg = id(await db.insert(organizations).values({ name: 'XYZ Paints' }).returning());
  hyd = id(
    await db.insert(stores).values({ organizationId: org, name: 'HYD', code: 'HYD' }).returning(),
  );
  pune = id(
    await db.insert(stores).values({ organizationId: org, name: 'PUN', code: 'PUN' }).returning(),
  );
  const role = id(
    await db.insert(roles).values({ organizationId: org, key: 'owner', name: 'Owner' }).returning(),
  );
  const user = id(
    await db.insert(users).values({ fullName: 'Owner', phone: '+919811100000' }).returning(),
  );
  member = id(
    await db
      .insert(organizationMembers)
      .values({ organizationId: org, userId: user, roleId: role })
      .returning(),
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
      .values({ organizationId: org, productId: product, sku: 'AP-1L', packSize: 1, unit: 'l' })
      .returning(),
  );
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('nextDocumentNumber', () => {
  it('counts 1, 2, 3 per organisation and series', async () => {
    expect(await number(org, 'transfer')).toBe(1);
    expect(await number(org, 'transfer')).toBe(2);
    expect(await number(org, 'invoice')).toBe(1);
    expect(await number(otherOrg, 'transfer')).toBe(1);
    expect(await number(org, 'transfer')).toBe(3);
  });

  it('never skips or repeats a number under concurrent use', async () => {
    const values = await Promise.all(Array.from({ length: 25 }, () => number(org, 'concurrent')));

    expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('gives the number back when the document is rolled back', async () => {
    await number(org, 'rollback');

    await expect(
      withTenant(connection.db, org, async (tx) => {
        await nextDocumentNumber(tx, org, 'rollback');
        throw new Error('document failed');
      }),
    ).rejects.toThrow('document failed');

    expect(await number(org, 'rollback')).toBe(2);
  });

  it("cannot take numbers from another organisation's series", async () => {
    const message = await failureMessage(
      withTenant(connection.db, org, (tx) => nextDocumentNumber(tx, otherOrg, 'transfer')),
    );

    expect(message).toMatch(/row-level security/);
  });
});

describe('transfers', () => {
  const newTransfer = (values: Partial<typeof transfers.$inferInsert> = {}) =>
    connection.db
      .insert(transfers)
      .values({
        organizationId: org,
        number: `TR-${String(Math.random()).slice(2, 10)}`,
        fromStoreId: pune,
        toStoreId: hyd,
        requestedByMemberId: member,
        ...values,
      })
      .returning();

  it('cannot move stock from a store to itself', async () => {
    const message = await failureMessage(newTransfer({ fromStoreId: hyd, toStoreId: hyd }));

    expect(message).toMatch(/transfers_different_stores/);
  });

  it('keeps transfer numbers unique per organisation', async () => {
    await newTransfer({ number: 'TR-DUPLICATE' });

    const message = await failureMessage(newTransfer({ number: 'TR-DUPLICATE' }));

    expect(message).toMatch(/transfers_organization_number_unique/);
  });

  it.each([
    [{ requestedQuantity: 0 }, /transfer_lines_requested_positive/],
    [{ requestedQuantity: 5, approvedQuantity: 6 }, /transfer_lines_approved_within_requested/],
    [
      { requestedQuantity: 5, approvedQuantity: 4, dispatchedQuantity: 5 },
      /transfer_lines_dispatched_within_approved/,
    ],
    [
      {
        requestedQuantity: 5,
        approvedQuantity: 5,
        dispatchedQuantity: 5,
        receivedQuantity: 4,
        damagedQuantity: 2,
      },
      /transfer_lines_received_within_dispatched/,
    ],
    [
      {
        requestedQuantity: 5,
        approvedQuantity: 5,
        dispatchedQuantity: 5,
        receivedQuantity: -1,
        damagedQuantity: 0,
      },
      /transfer_lines_received_within_dispatched/,
    ],
  ])('keeps quantities consistent through each stage: %o', async (quantities, constraint) => {
    const transfer = id(await newTransfer());

    const message = await failureMessage(
      connection.db.insert(transferLines).values({
        organizationId: org,
        transferId: transfer,
        variantId: variant,
        ...quantities,
      }),
    );

    expect(message).toMatch(constraint);
  });

  it('removes lines with their transfer, and isolates transfers per business', async () => {
    const transfer = id(await newTransfer());
    await connection.db.insert(transferLines).values({
      organizationId: org,
      transferId: transfer,
      variantId: variant,
      requestedQuantity: 2,
    });

    const seenByOther = await withTenant(connection.db, otherOrg, (tx) =>
      tx.select().from(transfers),
    );
    await connection.db.delete(transfers).where(eq(transfers.id, transfer));

    expect(seenByOther).toEqual([]);
    expect(
      await connection.db
        .select()
        .from(transferLines)
        .where(eq(transferLines.transferId, transfer)),
    ).toEqual([]);
  });
});
