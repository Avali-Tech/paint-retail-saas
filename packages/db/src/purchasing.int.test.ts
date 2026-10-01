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
  goodsReceiptLines,
  goodsReceipts,
  organizationMembers,
  organizations,
  parties,
  productVariants,
  products,
  purchaseOrderLines,
  purchaseOrders,
  roles,
  stores,
  supplierProducts,
  supplierProfiles,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let org: string;
let otherOrg: string;
let store: string;
let member: string;
let supplier: string;
let otherSupplier: string;
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

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  connection = createDatabase(database.connectionString);
  const { db } = connection;
  org = id(await db.insert(organizations).values({ name: 'ABC Paints' }).returning());
  otherOrg = id(await db.insert(organizations).values({ name: 'XYZ Paints' }).returning());
  store = id(
    await db.insert(stores).values({ organizationId: org, name: 'HYD', code: 'HYD' }).returning(),
  );
  const role = id(
    await db.insert(roles).values({ organizationId: org, key: 'owner', name: 'Owner' }).returning(),
  );
  const user = id(
    await db.insert(users).values({ fullName: 'Owner', phone: '+919811100001' }).returning(),
  );
  member = id(
    await db
      .insert(organizationMembers)
      .values({ organizationId: org, userId: user, roleId: role })
      .returning(),
  );
  supplier = id(
    await db
      .insert(parties)
      .values({ organizationId: org, displayName: 'Asian Depot' })
      .returning(),
  );
  otherSupplier = id(
    await db
      .insert(parties)
      .values({ organizationId: org, displayName: 'Berger Depot' })
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

describe('supplier profiles and products', () => {
  it('stores terms and the last cost, defaulting terms to cash', async () => {
    await connection.db.insert(supplierProfiles).values({ organizationId: org, partyId: supplier });
    await connection.db
      .insert(supplierProducts)
      .values({ organizationId: org, supplierPartyId: supplier, variantId: variant });

    const [profile] = await connection.db
      .select()
      .from(supplierProfiles)
      .where(eq(supplierProfiles.partyId, supplier));
    expect(profile).toMatchObject({ paymentTermsDays: 0, leadTimeDays: null });
  });

  it.each([
    [{ paymentTermsDays: -1 }, /supplier_profiles_payment_terms_range/],
    [{ paymentTermsDays: 366 }, /supplier_profiles_payment_terms_range/],
    [{ leadTimeDays: -1 }, /supplier_profiles_lead_time_range/],
  ])('keeps supplier terms in range: %o', async (values, constraint) => {
    const message = await failureMessage(
      connection.db
        .insert(supplierProfiles)
        .values({ organizationId: org, partyId: otherSupplier, ...values }),
    );

    expect(message).toMatch(constraint);
  });

  it('refuses a negative last cost', async () => {
    const message = await failureMessage(
      connection.db.insert(supplierProducts).values({
        organizationId: org,
        supplierPartyId: otherSupplier,
        variantId: variant,
        lastCostPaise: -1,
      }),
    );

    expect(message).toMatch(/supplier_products_last_cost_not_negative/);
  });

  it('cannot link a supplier from another business', async () => {
    const message = await failureMessage(
      connection.db
        .insert(supplierProfiles)
        .values({ organizationId: otherOrg, partyId: otherSupplier }),
    );

    expect(message).toMatch(/supplier_profiles_party_fk/);
  });
});

describe('purchase orders', () => {
  const newOrder = (values: Partial<typeof purchaseOrders.$inferInsert> = {}) =>
    connection.db
      .insert(purchaseOrders)
      .values({
        organizationId: org,
        number: `PO-${String(Math.random()).slice(2, 10)}`,
        supplierPartyId: supplier,
        storeId: store,
        createdByMemberId: member,
        ...values,
      })
      .returning();

  it('starts open and keeps numbers unique per organisation', async () => {
    const [order] = await newOrder({ number: 'PO-DUPLICATE' });

    const message = await failureMessage(newOrder({ number: 'PO-DUPLICATE' }));

    expect(order?.status).toBe('open');
    expect(message).toMatch(/purchase_orders_organization_number_unique/);
  });

  it.each([
    [{ orderedQuantity: 0 }, /purchase_order_lines_ordered_positive/],
    [{ orderedQuantity: 5, unitCostPaise: -1 }, /purchase_order_lines_cost_not_negative/],
    [{ orderedQuantity: 5, receivedQuantity: 6 }, /purchase_order_lines_received_within_ordered/],
    [{ orderedQuantity: 5, receivedQuantity: -1 }, /purchase_order_lines_received_within_ordered/],
  ])('keeps line quantities consistent: %o', async (quantities, constraint) => {
    const order = id(await newOrder());

    const message = await failureMessage(
      connection.db
        .insert(purchaseOrderLines)
        .values({ organizationId: org, purchaseOrderId: order, variantId: variant, ...quantities }),
    );

    expect(message).toMatch(constraint);
  });

  it('removes lines with their order, and isolates orders per business', async () => {
    const order = id(await newOrder());
    await connection.db.insert(purchaseOrderLines).values({
      organizationId: org,
      purchaseOrderId: order,
      variantId: variant,
      orderedQuantity: 2,
    });

    const seenByOther = await withTenant(connection.db, otherOrg, (tx) =>
      tx.select().from(purchaseOrders),
    );
    await connection.db.delete(purchaseOrders).where(eq(purchaseOrders.id, order));

    expect(seenByOther).toEqual([]);
    expect(
      await connection.db
        .select()
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.purchaseOrderId, order)),
    ).toEqual([]);
  });
});

describe('goods receipts', () => {
  const newReceipt = (values: Partial<typeof goodsReceipts.$inferInsert> = {}) =>
    connection.db
      .insert(goodsReceipts)
      .values({
        organizationId: org,
        number: `GRN-${String(Math.random()).slice(2, 10)}`,
        storeId: store,
        supplierPartyId: supplier,
        receivedByMemberId: member,
        ...values,
      })
      .returning();

  it("enters a supplier's invoice only once, ignoring case", async () => {
    await newReceipt({ supplierInvoiceNumber: 'INV/24-25/001' });

    const message = await failureMessage(newReceipt({ supplierInvoiceNumber: 'inv/24-25/001' }));

    expect(message).toMatch(/goods_receipts_supplier_invoice_unique/);
  });

  it('allows the same invoice number from a different supplier, and receipts without one', async () => {
    await newReceipt({ supplierInvoiceNumber: 'INV-7' });
    await newReceipt({ supplierInvoiceNumber: 'INV-7', supplierPartyId: otherSupplier });
    await newReceipt();
    await newReceipt();

    const rows = await connection.db
      .select()
      .from(goodsReceipts)
      .where(eq(goodsReceipts.supplierInvoiceNumber, 'INV-7'));
    expect(rows).toHaveLength(2);
  });

  it('cannot reference a purchase order from another business', async () => {
    const message = await failureMessage(
      newReceipt({ purchaseOrderId: '00000000-0000-4000-8000-000000000000' }),
    );

    expect(message).toMatch(/goods_receipts_purchase_order_fk/);
  });

  it.each([
    [{ quantity: 0, freeQuantity: 0 }, /goods_receipt_lines_quantities/],
    [{ quantity: -1, freeQuantity: 2 }, /goods_receipt_lines_quantities/],
    [{ quantity: 2, freeQuantity: -1 }, /goods_receipt_lines_quantities/],
    [{ quantity: 2, unitCostPaise: -1 }, /goods_receipt_lines_cost_not_negative/],
  ])('keeps receipt quantities sensible: %o', async (quantities, constraint) => {
    const receipt = id(await newReceipt());

    const message = await failureMessage(
      connection.db.insert(goodsReceiptLines).values({
        organizationId: org,
        goodsReceiptId: receipt,
        variantId: variant,
        ...quantities,
      }),
    );

    expect(message).toMatch(constraint);
  });

  it('accepts free scheme units alone, and isolates receipts per business', async () => {
    const receipt = id(await newReceipt());
    await connection.db.insert(goodsReceiptLines).values({
      organizationId: org,
      goodsReceiptId: receipt,
      variantId: variant,
      quantity: 0,
      freeQuantity: 3,
    });

    const seenByOther = await withTenant(connection.db, otherOrg, (tx) =>
      tx.select().from(goodsReceipts),
    );

    expect(seenByOther).toEqual([]);
    expect(
      await connection.db
        .select()
        .from(goodsReceiptLines)
        .where(eq(goodsReceiptLines.goodsReceiptId, receipt)),
    ).toEqual([expect.objectContaining({ quantity: 0, freeQuantity: 3, unitCostPaise: null })]);
  });
});
