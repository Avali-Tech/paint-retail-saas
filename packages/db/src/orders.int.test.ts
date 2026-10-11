import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  InsufficientStockError,
  createDatabase,
  findReservationMismatches,
  migrateDatabase,
  postStockMovements,
  releaseStock,
  reserveStock,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

const {
  auditLog,
  brands,
  creditProfiles,
  dispatchLines,
  dispatches,
  loyaltyAccounts,
  loyaltyLedger,
  organizationMembers,
  organizations,
  parties,
  productVariants,
  products,
  quotationLines,
  quotations,
  roles,
  salesOrderLines,
  salesOrders,
  salesSettings,
  stockBalances,
  stockReservations,
  stores,
  taxDocumentLines,
  taxDocuments,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;

interface Tenant {
  readonly org: string;
  readonly store: string;
  readonly empty: string;
  readonly member: string;
  readonly party: string;
  readonly variant: string;
}
let a: Tenant;
let b: Tenant;

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

async function tenant(name: string): Promise<Tenant> {
  const { db } = connection;
  const org = id(await db.insert(organizations).values({ name }).returning());
  const store = id(
    await db
      .insert(stores)
      .values({ organizationId: org, name: 'Ameerpet', code: 'AMP' })
      .returning(),
  );
  const empty = id(
    await db
      .insert(stores)
      .values({ organizationId: org, name: 'Kukatpally', code: 'KKP' })
      .returning(),
  );
  const role = id(
    await db.insert(roles).values({ organizationId: org, key: 'x', name: 'X' }).returning(),
  );
  const user = id(
    await db
      .insert(users)
      .values({ fullName: 'Ravi', email: `ravi-${crypto.randomUUID()}@example.com` })
      .returning(),
  );
  const member = id(
    await db
      .insert(organizationMembers)
      .values({ organizationId: org, userId: user, roleId: role })
      .returning(),
  );
  const party = id(
    await db.insert(parties).values({ organizationId: org, displayName: 'Lakshmi' }).returning(),
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
        hsnCode: '32091090',
        gstRateBps: 1800,
      })
      .returning(),
  );
  const variant = id(
    await db
      .insert(productVariants)
      .values({ organizationId: org, productId: product, sku: 'AP-1L', packSize: 1, unit: 'l' })
      .returning(),
  );
  await withTenant(db, org, (tx) =>
    postStockMovements(tx, [
      {
        organizationId: org,
        storeId: store,
        variantId: variant,
        movementType: 'opening',
        quantity: 10,
      },
    ]),
  );
  return { org, store, empty, member, party, variant };
}

/** Header columns of a priced quotation or order (zero totals). */
const header = (t: Tenant) => ({
  organizationId: t.org,
  storeId: t.store,
  billToPartyId: t.party,
  priceMode: 'inclusive' as const,
  pricedOn: '2026-10-07',
  placeOfSupplyCode: '36',
  supplyType: 'intra_state' as const,
  taxablePaise: 0,
  cgstPaise: 0,
  sgstPaise: 0,
  igstPaise: 0,
  cessPaise: 0,
  roundOffPaise: 0,
  totalPaise: 0,
  createdByMemberId: t.member,
});

const line = (t: Tenant, lineNo = 1) => ({
  organizationId: t.org,
  lineNo,
  variantId: t.variant,
  description: 'Apex 1 L',
  quantity: 4,
  unitPricePaise: 0,
  taxablePaise: 0,
  cgstPaise: 0,
  sgstPaise: 0,
  igstPaise: 0,
  cessPaise: 0,
  totalPaise: 0,
});

let numbers = 0;
const nextNumber = (prefix: string) => {
  numbers += 1;
  return `${prefix}-${String(numbers).padStart(6, '0')}`;
};

/** A draft order with one line of 4 at the tenant's stocked store. */
async function order(t: Tenant): Promise<{ order: string; line: string }> {
  return withTenant(connection.db, t.org, async (tx) => {
    const orderId = id(
      await tx
        .insert(salesOrders)
        .values({ ...header(t), number: nextNumber('SO'), paymentTerms: 'postpaid' })
        .returning(),
    );
    const lineId = id(
      await tx
        .insert(salesOrderLines)
        .values({ ...line(t), orderId, fulfilStoreId: t.store })
        .returning(),
    );
    return { order: orderId, line: lineId };
  });
}

async function confirm(t: Tenant, orderId: string): Promise<void> {
  await withTenant(connection.db, t.org, (tx) =>
    tx
      .update(salesOrders)
      .set({ status: 'confirmed', confirmedAt: sql`now()`, confirmedByMemberId: t.member })
      .where(eq(salesOrders.id, orderId)),
  );
}

async function reserved(t: Tenant, storeId = t.store): Promise<number | undefined> {
  const [row] = await connection.db
    .select({ reserved: stockBalances.reserved })
    .from(stockBalances)
    .where(and(eq(stockBalances.storeId, storeId), eq(stockBalances.variantId, t.variant)));
  return row?.reserved;
}

const reservationsOf = (lineId: string) =>
  connection.db
    .select({
      quantity: stockReservations.quantity,
      status: stockReservations.status,
      consumedByType: stockReservations.consumedByType,
    })
    .from(stockReservations)
    .where(eq(stockReservations.orderLineId, lineId))
    .orderBy(asc(stockReservations.createdAt));

const reserve = (t: Tenant, lineId: string, quantity: number, storeId = t.store) =>
  withTenant(connection.db, t.org, (tx) =>
    reserveStock(tx, [
      {
        organizationId: t.org,
        storeId,
        variantId: t.variant,
        orderLineId: lineId,
        quantity,
        createdByMemberId: t.member,
      },
    ]),
  );

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  connection = createDatabase(database.connectionString);
  a = await tenant('ABC Paints');
  b = await tenant('XYZ Paints');
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('reserveStock and releaseStock', () => {
  it('holds stock against an order line, and gives it back in parts', async () => {
    const { line: lineId } = await order(a);
    const before = Number(await reserved(a));

    const [reservationId] = await reserve(a, lineId, 4);
    expect(reservationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await reserved(a)).toBe(before + 4);

    // Part goes out on an invoice; the rest stays held.
    const invoice = crypto.randomUUID();
    expect(
      await withTenant(connection.db, a.org, (tx) =>
        releaseStock(tx, [
          { orderLineId: lineId, quantity: 1.5, consumedBy: { type: 'tax_document', id: invoice } },
        ]),
      ),
    ).toEqual([1.5]);
    expect(await reserved(a)).toBe(before + 2.5);
    expect(await reservationsOf(lineId)).toEqual([
      { quantity: 2.5, status: 'open', consumedByType: null },
      { quantity: 1.5, status: 'consumed', consumedByType: 'tax_document' },
    ]);

    // Asking for more than is held gives back what is held, then nothing is left.
    expect(
      await withTenant(connection.db, a.org, (tx) =>
        releaseStock(tx, [{ orderLineId: lineId, quantity: 9 }, { orderLineId: lineId }]),
      ),
    ).toEqual([2.5, 0]);
    expect(await reserved(a)).toBe(before);
    expect((await reservationsOf(lineId)).map((row) => row.status)).toEqual([
      'released',
      'consumed',
    ]);
    expect(await findReservationMismatches(connection.db)).toEqual([]);
    expect(await withTenant(connection.db, a.org, (tx) => releaseStock(tx, []))).toEqual([]);
  });

  it('closes the whole reservation when everything goes, and releases nothing for nothing', async () => {
    const { line: lineId } = await order(a);
    await reserve(a, lineId, 2);

    expect(
      await withTenant(connection.db, a.org, (tx) =>
        releaseStock(tx, [{ orderLineId: lineId, quantity: 0 }]),
      ),
    ).toEqual([0]);
    expect(
      await withTenant(connection.db, a.org, (tx) =>
        releaseStock(tx, [
          { orderLineId: lineId, consumedBy: { type: 'dispatch', id: crypto.randomUUID() } },
        ]),
      ),
    ).toEqual([2]);
    expect(await reservationsOf(lineId)).toEqual([
      { quantity: 2, status: 'consumed', consumedByType: 'dispatch' },
    ]);
  });

  it('refuses to hold more than is available, or anything where there is no stock', async () => {
    const { line: first } = await order(a);
    const { line: second } = await order(a);
    const available = 10 - Number(await reserved(a));
    await reserve(a, first, available);

    await expect(reserve(a, second, 0.001)).rejects.toBeInstanceOf(InsufficientStockError);
    await expect(reserve(a, second, 1, a.empty)).rejects.toBeInstanceOf(InsufficientStockError);
    // The stock itself cannot go below what is held either.
    await expect(
      withTenant(connection.db, a.org, (tx) =>
        postStockMovements(tx, [
          {
            organizationId: a.org,
            storeId: a.store,
            variantId: a.variant,
            movementType: 'adjustment',
            quantity: -1,
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    await withTenant(connection.db, a.org, (tx) => releaseStock(tx, [{ orderLineId: first }]));
  });

  it('passes other database errors through', async () => {
    const { line: lineId } = await order(a);
    expect(await failureMessage(reserve(a, lineId, 'many' as unknown as number))).toContain(
      'invalid input syntax',
    );
  });

  it('keeps one open reservation per line, and history only shrinks or closes', async () => {
    const { line: lineId } = await order(a);
    const [reservationId] = await reserve(a, lineId, 1);
    expect(await failureMessage(reserve(a, lineId, 1))).toContain(
      'stock_reservations_one_open_per_line',
    );
    const change = (values: PgUpdateSetSource<typeof stockReservations>) =>
      withTenant(connection.db, a.org, (tx) =>
        tx
          .update(stockReservations)
          .set(values)
          .where(eq(stockReservations.id, String(reservationId))),
      );
    expect(await failureMessage(change({ quantity: 2 }))).toContain('only shrinks or closes');
    expect(await failureMessage(change({ storeId: a.empty }))).toContain('only shrinks or closes');
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.delete(stockReservations).where(eq(stockReservations.id, String(reservationId))),
        ),
      ),
    ).toContain('permission denied');
    await withTenant(connection.db, a.org, (tx) => releaseStock(tx, [{ orderLineId: lineId }]));
    expect(await failureMessage(change({ status: 'open', closedAt: null }))).toContain(
      'only shrinks or closes',
    );
    // Even the owner of the tables cannot delete one.
    expect(
      await failureMessage(
        connection.db
          .delete(stockReservations)
          .where(eq(stockReservations.id, String(reservationId))),
      ),
    ).toContain('never deleted');
  });

  it('finds balances whose reserved stock disagrees with the open reservations', async () => {
    await connection.db
      .update(stockBalances)
      .set({ reserved: sql`${stockBalances.reserved} + 1` })
      .where(and(eq(stockBalances.storeId, b.store), eq(stockBalances.variantId, b.variant)));

    expect(await findReservationMismatches(connection.db)).toEqual([
      {
        organizationId: b.org,
        storeId: b.store,
        variantId: b.variant,
        reserved: 1,
        openReservations: 0,
      },
    ]);
    // In tenant scope, only the business's own.
    expect(await withTenant(connection.db, a.org, (tx) => findReservationMismatches(tx))).toEqual(
      [],
    );

    await connection.db
      .update(stockBalances)
      .set({ reserved: 0 })
      .where(and(eq(stockBalances.storeId, b.store), eq(stockBalances.variantId, b.variant)));
  });
});

describe('quotations: editable only while a draft', () => {
  async function quote(t: Tenant) {
    return withTenant(connection.db, t.org, async (tx) => {
      const quotationId = id(
        await tx
          .insert(quotations)
          .values({ ...header(t), number: nextNumber('QT'), validUntil: '2026-10-22' })
          .returning(),
      );
      await tx.insert(quotationLines).values({ ...line(t), quotationId });
      return quotationId;
    });
  }
  const update = (t: Tenant, quotationId: string, values: PgUpdateSetSource<typeof quotations>) =>
    withTenant(connection.db, t.org, (tx) =>
      tx.update(quotations).set(values).where(eq(quotations.id, quotationId)),
    );

  it('moves a sent quote only forward, and never changes its terms or lines', async () => {
    const quotationId = await quote(a);
    await update(a, quotationId, { note: 'Two coats' });
    await update(a, quotationId, { status: 'sent', sentAt: sql`now()` });

    expect(await failureMessage(update(a, quotationId, { note: 'Three coats' }))).toContain(
      'revise it as a new version',
    );
    expect(await failureMessage(update(a, quotationId, { status: 'draft' }))).toContain(
      'revise it as a new version',
    );
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.insert(quotationLines).values({ ...line(a, 2), quotationId }),
        ),
      ),
    ).toContain('lines of a sent quotation');
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.delete(quotationLines).where(eq(quotationLines.quotationId, quotationId)),
        ),
      ),
    ).toContain('lines of a sent quotation');
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.delete(quotations).where(eq(quotations.id, quotationId)),
        ),
      ),
    ).toContain('only a draft quotation is deleted');

    await update(a, quotationId, { status: 'accepted', acceptedAt: sql`now()` });
    await update(a, quotationId, { status: 'superseded' });
    expect(await failureMessage(update(a, quotationId, { status: 'sent' }))).toContain(
      'revise it as a new version',
    );
  });

  it('deletes a draft with its lines, and keeps one live version per number', async () => {
    const quotationId = await quote(a);
    const [{ number } = { number: '' }] = await connection.db
      .select({ number: quotations.number })
      .from(quotations)
      .where(eq(quotations.id, quotationId));
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.insert(quotations).values({
            ...header(a),
            number,
            version: 2,
            rootQuotationId: quotationId,
            validUntil: '2026-10-22',
          }),
        ),
      ),
    ).toContain('quotations_one_live_version');
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.insert(quotations).values({ ...header(a), number: 'Q-1', validUntil: '2026-10-22' }),
        ),
      ),
    ).toContain('quotations_number_format');

    await withTenant(connection.db, a.org, (tx) =>
      tx.delete(quotations).where(eq(quotations.id, quotationId)),
    );
    expect(
      await connection.db
        .select()
        .from(quotationLines)
        .where(eq(quotationLines.quotationId, quotationId)),
    ).toEqual([]);
  });
});

describe('sales orders: terms fixed once confirmed', () => {
  const update = (orderId: string, values: PgUpdateSetSource<typeof salesOrders>) =>
    withTenant(connection.db, a.org, (tx) =>
      tx.update(salesOrders).set(values).where(eq(salesOrders.id, orderId)),
    );
  const updateLine = (lineId: string, values: PgUpdateSetSource<typeof salesOrderLines>) =>
    withTenant(connection.db, a.org, (tx) =>
      tx.update(salesOrderLines).set(values).where(eq(salesOrderLines.id, lineId)),
    );

  it('lets only the status, cancellation and billed quantities change after confirm', async () => {
    const { order: orderId, line: lineId } = await order(a);
    await updateLine(lineId, { unitPricePaise: 11_800, totalPaise: 0 });
    await confirm(a, orderId);

    expect(await failureMessage(update(orderId, { note: 'Rush' }))).toContain(
      'a confirmed sales order cannot be changed',
    );
    expect(await failureMessage(update(orderId, { status: 'draft' }))).toContain(
      'a confirmed sales order cannot be changed',
    );
    expect(await failureMessage(updateLine(lineId, { unitPricePaise: 1 }))).toContain(
      'lines of a confirmed sales order',
    );
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.insert(salesOrderLines).values({ ...line(a, 2), orderId, fulfilStoreId: a.store }),
        ),
      ),
    ).toContain('lines of a confirmed sales order');
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.delete(salesOrderLines).where(eq(salesOrderLines.id, lineId)),
        ),
      ),
    ).toContain('lines of a confirmed sales order');
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.delete(salesOrders).where(eq(salesOrders.id, orderId)),
        ),
      ),
    ).toContain('cancel it instead');

    await updateLine(lineId, { quantityInvoiced: 1, fulfilStoreId: a.empty });
    expect(
      await failureMessage(updateLine(lineId, { quantityInvoiced: 4, quantityCancelled: 1 })),
    ).toContain('sales_order_lines_fulfilment');
    await update(orderId, { status: 'partly_fulfilled' });
    await updateLine(lineId, { quantityCancelled: 3 });
    await update(orderId, {
      status: 'closed',
      cancelReason: 'Customer changed shade',
      cancelledAt: sql`now()`,
      cancelledByMemberId: a.member,
    });
    expect(await failureMessage(update(orderId, { status: 'partly_fulfilled' }))).toContain(
      'a confirmed sales order cannot be changed',
    );
  });

  it('deletes a draft with its lines', async () => {
    const { order: orderId, line: lineId } = await order(a);
    await withTenant(connection.db, a.org, (tx) =>
      tx.delete(salesOrders).where(eq(salesOrders.id, orderId)),
    );
    expect(
      await connection.db.select().from(salesOrderLines).where(eq(salesOrderLines.id, lineId)),
    ).toEqual([]);
  });

  it('records the credit check and override together, only on a confirmed postpaid order', async () => {
    const { order: orderId } = await order(a);
    expect(
      await failureMessage(
        update(orderId, {
          creditOverrideApproval: 'owner',
          creditOverrideByMemberId: a.member,
          creditOverrideReason: 'Old customer',
          creditOverriddenAt: sql`now()`,
        }),
      ),
    ).toContain('sales_orders_credit');
    await update(orderId, {
      status: 'confirmed',
      confirmedAt: sql`now()`,
      confirmedByMemberId: a.member,
      creditCheck: { decision: 'owner_approval' },
      creditOverrideApproval: 'owner',
      creditOverrideByMemberId: a.member,
      creditOverrideReason: 'Old customer',
      creditOverriddenAt: sql`now()`,
    });

    const [audit] = await connection.db
      .select({ newValues: auditLog.newValues, actor: auditLog.actorMemberId })
      .from(auditLog)
      .where(and(eq(auditLog.tableName, 'sales_orders'), eq(auditLog.recordId, orderId)))
      .orderBy(sql`${auditLog.id} desc`)
      .limit(1);
    expect(audit?.newValues).toMatchObject({
      status: 'confirmed',
      credit_override_approval: 'owner',
      credit_override_reason: 'Old customer',
    });
  });

  it("never shows another business's orders, quotations or reservations", async () => {
    const { order: orderId, line: lineId } = await order(b);
    await reserve(b, lineId, 1);
    const seen = await withTenant(connection.db, a.org, async (tx) => ({
      orders: await tx.select().from(salesOrders).where(eq(salesOrders.id, orderId)),
      reservations: await tx
        .select()
        .from(stockReservations)
        .where(eq(stockReservations.orderLineId, lineId)),
    }));
    expect(seen).toEqual({ orders: [], reservations: [] });
    await withTenant(connection.db, b.org, (tx) => releaseStock(tx, [{ orderLineId: lineId }]));
  });
});

describe('dispatches: a permanent record', () => {
  it('can be added, never changed or removed', async () => {
    const invoice = await withTenant(connection.db, a.org, async (tx) => {
      const document = id(
        await tx
          .insert(taxDocuments)
          .values({
            organizationId: a.org,
            kind: 'invoice',
            storeId: a.store,
            partyId: a.party,
            createdByMemberId: a.member,
          })
          .returning(),
      );
      const invoiceLine = id(
        await tx
          .insert(taxDocumentLines)
          .values({
            organizationId: a.org,
            documentId: document,
            lineNo: 1,
            variantId: a.variant,
            quantity: 1,
            unitPricePaise: 11_800,
          })
          .returning(),
      );
      return { document, invoiceLine };
    });
    const dispatchId = await withTenant(connection.db, a.org, async (tx) => {
      const created = id(
        await tx
          .insert(dispatches)
          .values({
            organizationId: a.org,
            number: nextNumber('DS'),
            invoiceId: invoice.document,
            storeId: a.store,
            valuePaise: 11_800,
            stockPosted: false,
            ewayBillNo: '123456789012',
            createdByMemberId: a.member,
          })
          .returning(),
      );
      await tx.insert(dispatchLines).values({
        organizationId: a.org,
        dispatchId: created,
        invoiceLineId: invoice.invoiceLine,
        quantity: 1,
        valuePaise: 11_800,
      });
      return created;
    });

    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.update(dispatches).set({ vehicleNo: 'TS09' }).where(eq(dispatches.id, dispatchId)),
        ),
      ),
    ).toContain('permission denied');
    expect(
      await failureMessage(
        connection.db.delete(dispatchLines).where(eq(dispatchLines.dispatchId, dispatchId)),
      ),
    ).toContain('dispatch_lines is append-only');
    expect(
      await failureMessage(
        connection.db.update(dispatches).set({ note: 'x' }).where(eq(dispatches.id, dispatchId)),
      ),
    ).toContain('dispatches is append-only');
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.insert(dispatches).values({
            organizationId: a.org,
            number: nextNumber('DS'),
            invoiceId: invoice.document,
            storeId: a.store,
            valuePaise: 0,
            stockPosted: false,
            ewayBillNo: 'EWB1',
            createdByMemberId: a.member,
          }),
        ),
      ),
    ).toContain('dispatches_eway_bill_no');
  });
});

describe('go-live (spec §4.7)', () => {
  it('sets billing_live_on once, then keeps the hand-entered credit figures as they are', async () => {
    await withTenant(connection.db, b.org, async (tx) => {
      await tx
        .insert(creditProfiles)
        .values({ organizationId: b.org, partyId: b.party, manualExposurePaise: 500 });
      await tx.insert(salesSettings).values({ organizationId: b.org, billingLiveOn: '2026-10-01' });
    });
    const setLive = (liveOn: string | null) =>
      withTenant(connection.db, b.org, (tx) =>
        tx.update(salesSettings).set({ billingLiveOn: liveOn }),
      );
    expect(await failureMessage(setLive('2026-10-02'))).toContain('that date never changes');
    expect(await failureMessage(setLive(null))).toContain('that date never changes');
    await withTenant(connection.db, b.org, (tx) =>
      tx.update(salesSettings).set({ quoteValidityDays: 30 }),
    );

    const credit = (values: Partial<typeof creditProfiles.$inferInsert>) =>
      withTenant(connection.db, b.org, (tx) =>
        tx.update(creditProfiles).set(values).where(eq(creditProfiles.partyId, b.party)),
      );
    expect(await failureMessage(credit({ manualExposurePaise: 600 }))).toContain(
      'comes from its ledger now',
    );
    expect(await failureMessage(credit({ overdueDays: 3 }))).toContain('comes from its ledger now');
    await credit({ risk: 'high', openingOverdueSince: '2026-09-01' });
    const other = id(
      await connection.db
        .insert(parties)
        .values({ organizationId: b.org, displayName: 'New customer' })
        .returning(),
    );
    expect(
      await failureMessage(
        withTenant(connection.db, b.org, (tx) =>
          tx
            .insert(creditProfiles)
            .values({ organizationId: b.org, partyId: other, manualExposurePaise: 1 }),
        ),
      ),
    ).toContain('comes from its ledger now');
    await withTenant(connection.db, b.org, (tx) =>
      tx.insert(creditProfiles).values({ organizationId: b.org, partyId: other }),
    );

    const [audit] = await connection.db
      .select({ newValues: auditLog.newValues })
      .from(auditLog)
      .where(eq(auditLog.tableName, 'credit_profiles'))
      .orderBy(sql`${auditLog.id} desc`)
      .offset(1)
      .limit(1);
    expect(audit?.newValues).toEqual({ opening_overdue_since: '2026-09-01' });
  });

  it('lets the hand-entered figures change while billing is not live', async () => {
    await withTenant(connection.db, a.org, (tx) =>
      tx.insert(creditProfiles).values({
        organizationId: a.org,
        partyId: a.party,
        manualExposurePaise: 700,
        overdueDays: 4,
      }),
    );
  });
});

describe('loyalty points from invoices (spec §3.5)', () => {
  it('earns a purchase on an invoice once, and adjusts against a note', async () => {
    const { account, invoice } = await withTenant(connection.db, a.org, async (tx) => {
      const accountId = id(
        await tx
          .insert(loyaltyAccounts)
          .values({ organizationId: a.org, partyId: a.party, createdByMemberId: a.member })
          .returning(),
      );
      const document = id(
        await tx
          .insert(taxDocuments)
          .values({
            organizationId: a.org,
            kind: 'invoice',
            storeId: a.store,
            createdByMemberId: a.member,
          })
          .returning(),
      );
      return { account: accountId, invoice: document };
    });
    const entry = (values: Partial<typeof loyaltyLedger.$inferInsert>) =>
      withTenant(connection.db, a.org, (tx) =>
        tx.insert(loyaltyLedger).values({
          organizationId: a.org,
          accountId: account,
          kind: 'purchase',
          points: 10,
          reference: 'AMP/26-27/000001',
          createdByMemberId: a.member,
          ...values,
        }),
      );

    await entry({ taxDocumentId: invoice });
    expect(await failureMessage(entry({ taxDocumentId: invoice }))).toContain(
      'loyalty_ledger_invoice_purchase_unique',
    );
    expect(await failureMessage(entry({}))).toContain('loyalty_ledger_purchase');
    expect(
      await failureMessage(entry({ taxDocumentId: invoice, manualPurchasePaise: 10_000 })),
    ).toContain('loyalty_ledger_purchase');
    expect(
      await failureMessage(entry({ kind: 'award', taxDocumentId: invoice, reference: null })),
    ).toContain('loyalty_ledger_purchase');
    expect(
      await failureMessage(entry({ kind: 'award', manualPurchasePaise: 1, reference: null })),
    ).toContain('loyalty_ledger_purchase');
    await entry({ kind: 'adjust', points: -4, note: 'Credit note', taxDocumentId: invoice });
    await entry({ manualPurchasePaise: 10_000 });
  });
});
