import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

const {
  auditLog,
  brands,
  estimateOptions,
  estimateSurfaces,
  estimates,
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
  stores,
  taxDocumentLines,
  taxDocuments,
  tintRecords,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;

interface Tenant {
  readonly org: string;
  readonly store: string;
  readonly member: string;
  readonly party: string;
  readonly brand: string;
  readonly product: string;
  readonly variant: string;
  readonly other: string;
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
        coverageSqftPerLitre: 120,
        defaultCoats: 2,
        isTintable: true,
      })
      .returning(),
  );
  const variant = id(
    await db
      .insert(productVariants)
      .values({ organizationId: org, productId: product, sku: 'AP-4L', packSize: 4, unit: 'l' })
      .returning(),
  );
  const other = id(
    await db
      .insert(productVariants)
      .values({ organizationId: org, productId: product, sku: 'AP-1L', packSize: 1, unit: 'l' })
      .returning(),
  );
  return { org, store, member, party, brand, product, variant, other };
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

const line = (t: Tenant) => ({
  organizationId: t.org,
  lineNo: 1,
  variantId: t.variant,
  description: 'Apex 4 L',
  quantity: 2,
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

/** A draft quotation with one line; returns both ids. */
const quotation = (t: Tenant) =>
  withTenant(connection.db, t.org, async (tx) => {
    const document = id(
      await tx
        .insert(quotations)
        .values({ ...header(t), number: nextNumber('QT'), validUntil: '2026-12-31' })
        .returning(),
    );
    const lineId = id(
      await tx
        .insert(quotationLines)
        .values({ ...line(t), quotationId: document })
        .returning(),
    );
    return { document, line: lineId };
  });

const order = (t: Tenant) =>
  withTenant(connection.db, t.org, async (tx) => {
    const document = id(
      await tx
        .insert(salesOrders)
        .values({ ...header(t), number: nextNumber('SO'), paymentTerms: 'prepaid' })
        .returning(),
    );
    const lineId = id(
      await tx
        .insert(salesOrderLines)
        .values({ ...line(t), orderId: document, fulfilStoreId: t.store })
        .returning(),
    );
    return { document, line: lineId };
  });

const invoice = (t: Tenant, kind: 'invoice' | 'credit_note' = 'invoice') =>
  withTenant(connection.db, t.org, async (tx) => {
    const document = id(
      await tx
        .insert(taxDocuments)
        .values({ organizationId: t.org, kind, storeId: t.store, createdByMemberId: t.member })
        .returning(),
    );
    const lineId = id(
      await tx
        .insert(taxDocumentLines)
        .values({
          organizationId: t.org,
          documentId: document,
          lineNo: 1,
          variantId: t.variant,
          quantity: 2,
          unitPricePaise: 11_800,
        })
        .returning(),
    );
    return { document, line: lineId };
  });

type TintValues = typeof tintRecords.$inferInsert;
const tint = (t: Tenant, values: Partial<TintValues>): TintValues => ({
  organizationId: t.org,
  storeId: t.store,
  partyId: t.party,
  brandId: t.brand,
  shadeCode: 'X132',
  baseVariantId: t.variant,
  packQuantity: 2,
  createdByMemberId: t.member,
  ...values,
});

const insertTint = (t: Tenant, values: Partial<TintValues>) =>
  withTenant(connection.db, t.org, (tx) =>
    tx.insert(tintRecords).values(tint(t, values)).returning(),
  );

const tintsOf = (t: Tenant) =>
  withTenant(connection.db, t.org, (tx) => tx.select({ id: tintRecords.id }).from(tintRecords));

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

describe('products', () => {
  it('keeps paint fields optional, and sane when given', async () => {
    const [hinge] = await withTenant(connection.db, a.org, (tx) =>
      tx
        .insert(products)
        .values({
          organizationId: a.org,
          brandId: a.brand,
          name: 'Hinge',
          type: 'tool',
          hsnCode: '83021010',
          gstRateBps: 1800,
        })
        .returning(),
    );
    expect(hinge).toMatchObject({
      coverageSqftPerLitre: null,
      defaultCoats: null,
      isTintable: false,
    });
    const set = (values: Partial<typeof products.$inferInsert>) =>
      withTenant(connection.db, a.org, (tx) =>
        tx.update(products).set(values).where(eq(products.id, a.product)),
      );
    expect(await failureMessage(set({ coverageSqftPerLitre: 0 }))).toContain(
      'products_coverage_positive',
    );
    expect(await failureMessage(set({ defaultCoats: 6 }))).toContain(
      'products_default_coats_range',
    );
    expect(await failureMessage(set({ coverageSqftPerLitre: 10_000 }))).toContain(
      'numeric field overflow',
    );
  });
});

describe('tint records', () => {
  it('tints a line of a draft quotation, order or invoice, once per line', async () => {
    const q = await quotation(a);
    const o = await order(a);
    const i = await invoice(a);
    await insertTint(a, { quotationLineId: q.line });
    await insertTint(a, {
      salesOrderLineId: o.line,
      formula: [{ colorant: 'XY', amount: 1.5, unit: 'ml' }],
    });
    const [saved] = await insertTint(a, { invoiceLineId: i.line, shadeName: 'Moon Mist' });
    expect(saved).toMatchObject({ shadeCode: 'X132', tintChargePaise: 0, formula: [] });

    expect(await failureMessage(insertTint(a, { invoiceLineId: i.line }))).toContain(
      'tint_records_invoice_line_unique',
    );
    expect(
      await failureMessage(insertTint(a, { quotationLineId: q.line, invoiceLineId: i.line })),
    ).toContain('tint_records_one_line');
    expect(await failureMessage(insertTint(a, {}))).toContain('tint_records_one_line');
  });

  it('keeps the shade code normalised and the figures sane', async () => {
    const check = async (values: Partial<TintValues>, constraint: string) => {
      const q = await quotation(a);
      expect(await failureMessage(insertTint(a, { quotationLineId: q.line, ...values }))).toContain(
        constraint,
      );
    };
    await check({ shadeCode: 'x132' }, 'tint_records_shade_code_format');
    await check({ shadeCode: ' X132' }, 'tint_records_shade_code_format');
    await check({ shadeCode: 'X  132' }, 'tint_records_shade_code_format');
    await check({ shadeCode: '' }, 'tint_records_shade_code_format');
    await check({ shadeCode: 'X'.repeat(41) }, 'tint_records_shade_code_format');
    await check({ packQuantity: 0 }, 'tint_records_pack_quantity_positive');
    await check({ tintChargePaise: -1 }, 'tint_records_amounts');
    await check({ colorantCostPaise: -1 }, 'tint_records_amounts');
    await check({ formula: {} as never }, 'tint_records_formula');
    await check(
      { formula: Array.from({ length: 17 }, () => ({ colorant: 'B', amount: 1, unit: 'ml' })) },
      'tint_records_formula',
    );
    await check({ shadeName: '' }, 'tint_records_text_lengths');
    await check({ machine: 'M'.repeat(81) }, 'tint_records_text_lengths');
    await check({ note: 'N'.repeat(501) }, 'tint_records_text_lengths');
  });

  it('takes its base from the line, and only invoice and bill-of-supply lines', async () => {
    const q = await quotation(a);
    expect(
      await failureMessage(insertTint(a, { quotationLineId: q.line, baseVariantId: a.other })),
    ).toContain("a tint record's base is its line's variant");
    const note = await invoice(a, 'credit_note');
    expect(await failureMessage(insertTint(a, { invoiceLineId: note.line }))).toContain(
      'only a line of an invoice or bill of supply is tinted',
    );
  });

  it('is never changed, and leaves with its line only while the document is a draft', async () => {
    const q = await quotation(a);
    const [record] = await insertTint(a, { quotationLineId: q.line });
    const recordId = String(record?.id);
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.update(tintRecords).set({ shadeCode: 'L104' }).where(eq(tintRecords.id, recordId)),
        ),
      ),
    ).toContain('permission denied');
    // Even the owner of the tables cannot change one.
    expect(
      await failureMessage(
        connection.db
          .update(tintRecords)
          .set({ shadeCode: 'L104' })
          .where(eq(tintRecords.id, recordId)),
      ),
    ).toContain('a tint record is never changed');

    // Sent: the line and its shade are history.
    await withTenant(connection.db, a.org, (tx) =>
      tx
        .update(quotations)
        .set({ status: 'sent', sentAt: sql`now()` })
        .where(eq(quotations.id, q.document)),
    );
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.delete(tintRecords).where(eq(tintRecords.id, recordId)),
        ),
      ),
    ).toContain('only a line of a draft is tinted or untinted');
    const q2 = await quotation(a);
    await withTenant(connection.db, a.org, (tx) =>
      tx
        .update(quotations)
        .set({ status: 'sent', sentAt: sql`now()` })
        .where(eq(quotations.id, q2.document)),
    );
    expect(await failureMessage(insertTint(a, { quotationLineId: q2.line }))).toContain(
      'only a line of a draft is tinted or untinted',
    );

    // A confirmed order's lines too.
    const o = await order(a);
    await withTenant(connection.db, a.org, (tx) =>
      tx
        .update(salesOrders)
        .set({ status: 'confirmed', confirmedAt: sql`now()`, confirmedByMemberId: a.member })
        .where(eq(salesOrders.id, o.document)),
    );
    expect(await failureMessage(insertTint(a, { salesOrderLineId: o.line }))).toContain(
      'only a line of a draft is tinted or untinted',
    );
  });

  it('goes with the lines of a draft when they are replaced or the draft is deleted', async () => {
    const before = (await tintsOf(a)).length;
    const q = await quotation(a);
    const o = await order(a);
    const i = await invoice(a);
    const [kept] = await insertTint(a, { quotationLineId: q.line });
    await insertTint(a, { salesOrderLineId: o.line });
    await insertTint(a, { invoiceLineId: i.line });
    // Untinting a draft's line directly is allowed.
    await withTenant(connection.db, a.org, (tx) =>
      tx.delete(tintRecords).where(eq(tintRecords.id, String(kept?.id))),
    );
    await insertTint(a, { quotationLineId: q.line });
    expect((await tintsOf(a)).length).toBe(before + 3);

    await withTenant(connection.db, a.org, async (tx) => {
      await tx.delete(quotationLines).where(eq(quotationLines.id, q.line));
      await tx.delete(salesOrders).where(eq(salesOrders.id, o.document));
      await tx.delete(taxDocuments).where(eq(taxDocuments.id, i.document));
    });
    expect((await tintsOf(a)).length).toBe(before);
  });

  it("never points at another business's line, store or party", async () => {
    const q = await quotation(b);
    expect(await failureMessage(insertTint(a, { quotationLineId: q.line }))).toContain(
      'tint_records_quotation_line_fk',
    );
    const mine = await quotation(a);
    expect(
      await failureMessage(insertTint(a, { quotationLineId: mine.line, partyId: b.party })),
    ).toContain('tint_records_party_fk');
    // And another business's rows are invisible.
    await insertTint(b, { quotationLineId: q.line });
    const seen = await withTenant(connection.db, a.org, (tx) =>
      tx.select({ org: tintRecords.organizationId }).from(tintRecords),
    );
    expect(seen.every((row) => row.org === a.org)).toBe(true);
  });
});

describe('estimates', () => {
  const estimate = (t: Tenant, values: Partial<typeof estimates.$inferInsert> = {}) =>
    withTenant(connection.db, t.org, async (tx) =>
      id(
        await tx
          .insert(estimates)
          .values({
            organizationId: t.org,
            number: nextNumber('ES'),
            storeId: t.store,
            partyId: t.party,
            createdByMemberId: t.member,
            ...values,
          })
          .returning(),
      ),
    );
  const surface = (
    t: Tenant,
    estimateId: string,
    values: Partial<typeof estimateSurfaces.$inferInsert>,
  ) =>
    withTenant(connection.db, t.org, (tx) =>
      tx.insert(estimateSurfaces).values({
        organizationId: t.org,
        estimateId,
        position: 1,
        room: 'Hall',
        kind: 'interior_wall',
        condition: 'repaint',
        primer: false,
        putty: false,
        ...values,
      }),
    );

  it('numbers estimates and keeps wastage and texts in range', async () => {
    expect(await failureMessage(estimate(a, { number: 'EST-1' }))).toContain(
      'estimates_number_format',
    );
    expect(await failureMessage(estimate(a, { wastageBps: 5001 }))).toContain(
      'estimates_wastage_range',
    );
    expect(await failureMessage(estimate(a, { title: '' }))).toContain('estimates_text_lengths');
    expect(await failureMessage(estimate(a, { status: 'converted' }))).toContain(
      'estimates_converted',
    );
  });

  it('measures a surface by area or by length × height, less openings', async () => {
    const estimateId = await estimate(a);
    await surface(a, estimateId, { areaSqft: 120.5, openingsSqft: 20 });
    await surface(a, estimateId, { position: 2, lengthFt: 12, heightFt: 10, openingsSqft: 120 });
    const fails = async (
      values: Partial<typeof estimateSurfaces.$inferInsert>,
      constraint: string,
    ) => {
      expect(await failureMessage(surface(a, estimateId, { position: 3, ...values }))).toContain(
        constraint,
      );
    };
    await fails({}, 'estimate_surfaces_size');
    await fails({ areaSqft: 10, lengthFt: 2, heightFt: 5 }, 'estimate_surfaces_size');
    await fails({ lengthFt: 2 }, 'estimate_surfaces_size');
    await fails({ areaSqft: 0 }, 'estimate_surfaces_size');
    await fails({ lengthFt: 12, heightFt: 10, openingsSqft: 120.01 }, 'estimate_surfaces_openings');
    await fails({ areaSqft: 10, openingsSqft: -1 }, 'estimate_surfaces_openings');
    await fails({ areaSqft: 10, coats: 0 }, 'estimate_surfaces_coats_range');
    await fails({ areaSqft: 10, room: ' Hall' }, 'estimate_surfaces_room');
    await fails({ areaSqft: 10, position: 0 }, 'estimate_surfaces_position_positive');
    await fails({ areaSqft: 10, position: 1 }, 'estimate_surfaces_estimate_position_unique');
  });

  it('stores an option per tier, its result all at once or not at all', async () => {
    const estimateId = await estimate(a);
    const option = (values: Partial<typeof estimateOptions.$inferInsert>) =>
      withTenant(connection.db, a.org, (tx) =>
        tx
          .insert(estimateOptions)
          .values({
            organizationId: a.org,
            estimateId,
            tier: 'good',
            productId: a.product,
            ...values,
          })
          .returning(),
      );
    const [good] = await option({});
    expect(good).toMatchObject({ litres: null, lines: null, totalPaise: null, computedAt: null });
    expect(await failureMessage(option({}))).toContain('estimate_options_estimate_tier_unique');
    expect(await failureMessage(option({ tier: 'better', litres: 1 }))).toContain(
      'estimate_options_computed',
    );
    expect(
      await failureMessage(
        option({
          tier: 'best',
          litres: 1,
          lines: {} as never,
          totalPaise: 0,
          computedAt: new Date(),
        }),
      ),
    ).toContain('estimate_options_computed');
    await withTenant(connection.db, a.org, (tx) =>
      tx
        .update(estimateOptions)
        .set({ litres: 23.625, lines: [], totalPaise: 0, computedAt: sql`now()` })
        .where(eq(estimateOptions.id, String(good?.id))),
    );
  });

  it('is final once converted: no change, no delete, nothing added', async () => {
    const estimateId = await estimate(a);
    await surface(a, estimateId, { areaSqft: 100 });
    const q = await quotation(a);
    await withTenant(connection.db, a.org, (tx) =>
      tx
        .update(estimates)
        .set({
          status: 'converted',
          quotationId: q.document,
          convertedTier: 'good',
          convertedAt: sql`now()`,
        })
        .where(eq(estimates.id, estimateId)),
    );
    const change = (work: Parameters<typeof withTenant>[2]) =>
      failureMessage(withTenant(connection.db, a.org, work));
    expect(
      await change((tx) =>
        tx.update(estimates).set({ title: 'Villa' }).where(eq(estimates.id, estimateId)),
      ),
    ).toContain('a converted estimate cannot be changed or deleted');
    expect(
      await change((tx) => tx.delete(estimates).where(eq(estimates.id, estimateId))),
    ).toContain('a converted estimate cannot be changed or deleted');
    expect(
      await change((tx) =>
        tx
          .update(estimateSurfaces)
          .set({ room: 'Den' })
          .where(eq(estimateSurfaces.estimateId, estimateId)),
      ),
    ).toContain('a converted estimate cannot be changed');
    expect(await failureMessage(surface(a, estimateId, { position: 2, areaSqft: 5 }))).toContain(
      'a converted estimate cannot be changed',
    );

    const audit = await connection.db
      .select({ action: auditLog.action, newValues: auditLog.newValues })
      .from(auditLog)
      .where(eq(auditLog.recordId, estimateId));
    expect(audit).toEqual([
      expect.objectContaining({ action: 'insert' }),
      {
        action: 'update',
        newValues: { status: 'converted', quotation_id: q.document, converted_tier: 'good' },
      },
    ]);
  });

  it('deletes a draft with its surfaces and options', async () => {
    const estimateId = await estimate(a);
    await surface(a, estimateId, { areaSqft: 100 });
    await withTenant(connection.db, a.org, (tx) =>
      tx.delete(estimates).where(eq(estimates.id, estimateId)),
    );
    const left = await withTenant(connection.db, a.org, (tx) =>
      tx.select().from(estimateSurfaces).where(eq(estimateSurfaces.estimateId, estimateId)),
    );
    expect(left).toEqual([]);
  });
});
