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

// MVP 3 round 5a (migrations 0083–0085): brand schemes, their slabs and benefits, what
// the brand issued against them and the claims filed with the brand.

const {
  auditLog,
  brandBenefitReceipts,
  brandClaims,
  brandSchemeBenefits,
  brandSchemeItems,
  brandSchemeSlabs,
  brandSchemes,
  brands,
  categories,
  goodsReceipts,
  organizationMembers,
  organizations,
  parties,
  productVariants,
  products,
  roles,
  stores,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;

interface Tenant {
  readonly org: string;
  readonly member: string;
  readonly brand: string;
  readonly category: string;
  readonly product: string;
  readonly variant: string;
  readonly grn: string;
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
  const supplier = id(
    await db
      .insert(parties)
      .values({ organizationId: org, displayName: 'Distributor' })
      .returning(),
  );
  const brand = id(
    await db.insert(brands).values({ organizationId: org, name: 'Apex Paints' }).returning(),
  );
  const category = id(
    await db.insert(categories).values({ organizationId: org, name: 'Emulsions' }).returning(),
  );
  const product = id(
    await db
      .insert(products)
      .values({
        organizationId: org,
        brandId: brand,
        categoryId: category,
        name: 'Ultima',
        type: 'interior_paint',
        hsnCode: '3209',
        gstRateBps: 1800,
      })
      .returning(),
  );
  const variant = id(
    await db
      .insert(productVariants)
      .values({ organizationId: org, productId: product, sku: 'ULT-20L', packSize: 20, unit: 'l' })
      .returning(),
  );
  const grn = id(
    await db
      .insert(goodsReceipts)
      .values({
        organizationId: org,
        number: 'GRN-000001',
        storeId: store,
        supplierPartyId: supplier,
        receivedByMemberId: member,
      })
      .returning(),
  );
  return { org, member, brand, category, product, variant, grn };
}

type SchemeValues = Partial<typeof brandSchemes.$inferInsert>;
let schemeNames = 0;
const scheme = (t: Tenant, values: SchemeValues = {}) => {
  schemeNames += 1;
  return withTenant(connection.db, t.org, async (tx) =>
    id(
      await tx
        .insert(brandSchemes)
        .values({
          organizationId: t.org,
          brandId: t.brand,
          name: `Q3 slab ${String(schemeNames)}`,
          startsOn: '2026-10-01',
          endsOn: '2026-12-31',
          measure: 'value',
          createdByMemberId: t.member,
          ...values,
        })
        .returning(),
    ),
  );
};
const setScheme = (t: Tenant, schemeId: string, values: SchemeValues) =>
  withTenant(connection.db, t.org, (tx) =>
    tx.update(brandSchemes).set(values).where(eq(brandSchemes.id, schemeId)),
  );
const ended = (t: Tenant, status: 'closed' | 'cancelled'): SchemeValues => ({
  status,
  endedAt: new Date(),
  endedByMemberId: t.member,
});

const slab = (t: Tenant, schemeId: string, position: number, target: number) =>
  withTenant(connection.db, t.org, async (tx) =>
    id(
      await tx
        .insert(brandSchemeSlabs)
        .values({ organizationId: t.org, schemeId, position, target })
        .returning(),
    ),
  );

type BenefitValues = Partial<typeof brandSchemeBenefits.$inferInsert>;
const benefit = (t: Tenant, schemeId: string, slabId: string, values: BenefitValues) =>
  withTenant(connection.db, t.org, async (tx) =>
    id(
      await tx
        .insert(brandSchemeBenefits)
        .values({ organizationId: t.org, schemeId, slabId, position: 1, kind: 'rebate', ...values })
        .returning(),
    ),
  );

type ReceiptValues = Partial<typeof brandBenefitReceipts.$inferInsert>;
const receipt = (t: Tenant, schemeId: string, values: ReceiptValues = {}) =>
  withTenant(connection.db, t.org, async (tx) =>
    id(
      await tx
        .insert(brandBenefitReceipts)
        .values({
          organizationId: t.org,
          schemeId,
          kind: 'money',
          receivedOn: '2026-11-15',
          amountPaise: 50_000,
          moneyForm: 'credit_note',
          reference: 'CN-881',
          recordedByMemberId: t.member,
          ...values,
        })
        .returning(),
    ),
  );

type ClaimValues = Partial<typeof brandClaims.$inferInsert>;
let claimNumbers = 0;
const claim = (t: Tenant, schemeId: string, values: ClaimValues = {}) => {
  claimNumbers += 1;
  return withTenant(connection.db, t.org, async (tx) =>
    id(
      await tx
        .insert(brandClaims)
        .values({
          organizationId: t.org,
          schemeId,
          number: `SC-${String(claimNumbers).padStart(6, '0')}`,
          filedOn: '2027-01-05',
          claimedPaise: 120_000,
          filedByMemberId: t.member,
          ...values,
        })
        .returning(),
    ),
  );
};
const setClaim = (t: Tenant, claimId: string, values: ClaimValues) =>
  withTenant(connection.db, t.org, (tx) =>
    tx.update(brandClaims).set(values).where(eq(brandClaims.id, claimId)),
  );

const audit = (table: string, recordId: string) =>
  connection.db
    .select({ action: auditLog.action, newValues: auditLog.newValues })
    .from(auditLog)
    .where(sql`${auditLog.tableName} = ${table} and ${auditLog.recordId} = ${recordId}`)
    .orderBy(auditLog.id);

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

describe('brand schemes', () => {
  it('default to a retro draft counted by GRN date, and check their period, text and settlement days', async () => {
    const kept = await scheme(a);
    const [row] = await connection.db.select().from(brandSchemes).where(eq(brandSchemes.id, kept));
    expect(row).toMatchObject({
      mode: 'retro',
      status: 'draft',
      dateBasis: 'grn_date',
      settlementDays: null,
    });
    expect(await failureMessage(scheme(a, { endsOn: '2026-09-30' }))).toMatch(
      /brand_schemes_period/,
    );
    expect(await failureMessage(scheme(a, { endsOn: '2028-10-01' }))).toMatch(
      /brand_schemes_period/,
    );
    expect(await failureMessage(scheme(a, { name: ' Padded ' }))).toMatch(/brand_schemes_text/);
    expect(await failureMessage(scheme(a, { settlementDays: 366 }))).toMatch(
      /brand_schemes_settlement_days/,
    );
    expect(await failureMessage(scheme(a, { status: 'closed' }))).toMatch(/brand_schemes_ended/);
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.insert(brandSchemes).values({
            organizationId: a.org,
            brandId: a.brand,
            name: 'q3 SLAB 1',
            startsOn: '2026-10-01',
            endsOn: '2026-12-31',
            measure: 'litres',
            createdByMemberId: a.member,
          }),
        ),
      ),
    ).toMatch(/brand_schemes_brand_name_unique/);
    expect(await failureMessage(scheme(a, { brandId: b.brand }))).toMatch(/brand_schemes_brand_fk/);
  });

  it('move forward only, keep their brand, close for good and are never deleted', async () => {
    const kept = await scheme(a);
    await setScheme(a, kept, { name: 'Renamed while a draft', settlementDays: 30 });
    expect(
      await failureMessage(setScheme(a, kept, { status: 'closed', ...ended(a, 'closed') })),
    ).toMatch(/a draft brand scheme cannot become closed/);
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, async (tx) => {
          const [other] = await tx
            .insert(brands)
            .values({ organizationId: a.org, name: 'Other' })
            .returning();
          await tx
            .update(brandSchemes)
            .set({ brandId: other?.id })
            .where(eq(brandSchemes.id, kept));
        }),
      ),
    ).toMatch(/keeps its business, brand and author/);
    await setScheme(a, kept, { status: 'active' });
    expect(await failureMessage(setScheme(a, kept, { status: 'draft' }))).toMatch(
      /active brand scheme cannot become draft/,
    );
    await setScheme(a, kept, { ...ended(a, 'closed'), endNote: 'Brand paid in full' });
    expect(await failureMessage(setScheme(a, kept, { name: 'Too late' }))).toMatch(
      /a closed brand scheme does not change/,
    );
    await setScheme(a, kept, { updatedAt: new Date() });
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.delete(brandSchemes).where(eq(brandSchemes.id, kept)),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await failureMessage(connection.db.delete(brandSchemes).where(eq(brandSchemes.id, kept))),
    ).toMatch(/never deleted/);

    const cancelled = await scheme(a);
    await setScheme(a, cancelled, ended(a, 'cancelled'));
    expect(await failureMessage(setScheme(a, cancelled, { status: 'active' }))).toMatch(
      /a cancelled brand scheme does not change/,
    );
  });

  it('stay within their business and are audited', async () => {
    const kept = await scheme(a);
    const seen = await withTenant(connection.db, b.org, (tx) =>
      tx.select({ id: brandSchemes.id }).from(brandSchemes).where(eq(brandSchemes.id, kept)),
    );
    expect(seen).toEqual([]);
    await setScheme(a, kept, { status: 'active' });
    const rows = await audit('brand_schemes', kept);
    expect(rows.map((row) => row.action)).toEqual(['insert', 'update']);
    expect(rows[1]?.newValues).toEqual({ status: 'active' });
  });
});

describe('what a scheme covers, its slabs and benefits', () => {
  it('name one product or category each, once, of the same business', async () => {
    const kept = await scheme(a);
    const item = (values: Partial<typeof brandSchemeItems.$inferInsert>) =>
      withTenant(connection.db, a.org, (tx) =>
        tx.insert(brandSchemeItems).values({ organizationId: a.org, schemeId: kept, ...values }),
      );
    await item({ productId: a.product });
    await item({ categoryId: a.category });
    expect(await failureMessage(item({ productId: a.product }))).toMatch(
      /brand_scheme_items_product_unique/,
    );
    expect(await failureMessage(item({ categoryId: a.category }))).toMatch(
      /brand_scheme_items_category_unique/,
    );
    expect(await failureMessage(item({}))).toMatch(/brand_scheme_items_one/);
    expect(await failureMessage(item({ productId: a.product, categoryId: a.category }))).toMatch(
      /brand_scheme_items_one/,
    );
    expect(await failureMessage(item({ productId: b.product }))).toMatch(
      /brand_scheme_items_product_fk/,
    );
    const rows = await audit('brand_scheme_items', kept);
    expect(rows.map((row) => row.newValues)).toEqual([
      { product_id: a.product, category_id: null },
      { product_id: null, category_id: a.category },
    ]);
  });

  it('keep slabs in positions with distinct positive targets', async () => {
    const kept = await scheme(a);
    await slab(a, kept, 1, 5_00_000_00);
    expect(await failureMessage(slab(a, kept, 1, 10_00_000_00))).toMatch(
      /brand_scheme_slabs_position_unique/,
    );
    expect(await failureMessage(slab(a, kept, 2, 5_00_000_00))).toMatch(
      /brand_scheme_slabs_target_unique/,
    );
    expect(await failureMessage(slab(a, kept, 2, 0))).toMatch(/brand_scheme_slabs_target/);
    expect(await failureMessage(slab(a, kept, 21, 1))).toMatch(/brand_scheme_slabs_position/);
  });

  it('give a benefit with exactly the columns its kind needs, within bounds', async () => {
    const kept = await scheme(a);
    const slabId = await slab(a, kept, 1, 1_00_000_00);
    await benefit(a, kept, slabId, { position: 1, kind: 'rebate', basisPoints: 150 });
    await benefit(a, kept, slabId, { position: 2, kind: 'per_litre', paisePerLitre: 300 });
    await benefit(a, kept, slabId, {
      position: 3,
      kind: 'free_goods',
      variantId: a.variant,
      units: 1,
      perMillilitres: 200_000,
    });
    await benefit(a, kept, slabId, { position: 4, kind: 'points', label: 'Goa trip', points: 2 });
    expect(await failureMessage(benefit(a, kept, slabId, { position: 5, kind: 'rebate' }))).toMatch(
      /brand_scheme_benefits_kind/,
    );
    expect(
      await failureMessage(
        benefit(a, kept, slabId, { position: 5, kind: 'rebate', basisPoints: 1, units: 1 }),
      ),
    ).toMatch(/brand_scheme_benefits_kind/);
    expect(
      await failureMessage(
        benefit(a, kept, slabId, {
          position: 5,
          kind: 'points',
          label: 'x',
          perMillilitres: 1,
          points: 1,
        }),
      ),
    ).toMatch(/brand_scheme_benefits_kind/);
    expect(
      await failureMessage(benefit(a, kept, slabId, { position: 5, basisPoints: 10_001 })),
    ).toMatch(/brand_scheme_benefits_amounts/);
    expect(
      await failureMessage(
        benefit(a, kept, slabId, { position: 5, kind: 'points', label: ' Gift', points: 1 }),
      ),
    ).toMatch(/brand_scheme_benefits_amounts/);
    expect(
      await failureMessage(benefit(a, kept, slabId, { position: 1, basisPoints: 100 })),
    ).toMatch(/brand_scheme_benefits_position_unique/);
    const otherScheme = await scheme(a);
    expect(
      await failureMessage(benefit(a, otherScheme, slabId, { position: 9, basisPoints: 100 })),
    ).toMatch(/brand_scheme_benefits_slab_fk/);
    expect(
      await failureMessage(
        benefit(a, kept, slabId, {
          position: 9,
          kind: 'free_goods',
          variantId: b.variant,
          units: 1,
        }),
      ),
    ).toMatch(/brand_scheme_benefits_variant_fk/);
  });

  it('change while the scheme is a draft or active, never once it is closed or cancelled', async () => {
    const kept = await scheme(a);
    const first = await slab(a, kept, 1, 1_000);
    await benefit(a, kept, first, { basisPoints: 100 });
    await setScheme(a, kept, { status: 'active' });
    // Editing replaces the slabs: delete them (their benefits go with them) and insert anew.
    await withTenant(connection.db, a.org, (tx) =>
      tx.delete(brandSchemeSlabs).where(eq(brandSchemeSlabs.schemeId, kept)),
    );
    const second = await slab(a, kept, 1, 2_000);
    await benefit(a, kept, second, { basisPoints: 200 });
    await withTenant(connection.db, a.org, (tx) =>
      tx
        .update(brandSchemeBenefits)
        .set({ basisPoints: 250 })
        .where(eq(brandSchemeBenefits.slabId, second)),
    );
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, async (tx) => {
          const other = await tx
            .insert(brandSchemes)
            .values({
              organizationId: a.org,
              brandId: a.brand,
              name: `Moved ${crypto.randomUUID()}`,
              startsOn: '2026-10-01',
              endsOn: '2026-12-31',
              measure: 'value',
              createdByMemberId: a.member,
            })
            .returning();
          await tx
            .update(brandSchemeSlabs)
            .set({ schemeId: id(other) })
            .where(eq(brandSchemeSlabs.id, second));
        }),
      ),
    ).toMatch(/stays with its scheme/);

    await setScheme(a, kept, ended(a, 'closed'));
    expect(await failureMessage(slab(a, kept, 2, 3_000))).toMatch(
      /a closed brand scheme does not change/,
    );
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.delete(brandSchemeSlabs).where(eq(brandSchemeSlabs.id, second)),
        ),
      ),
    ).toMatch(/a closed brand scheme does not change/);
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx
            .insert(brandSchemeItems)
            .values({ organizationId: a.org, schemeId: kept, productId: a.product }),
        ),
      ),
    ).toMatch(/a closed brand scheme does not change/);

    const slabs = await audit('brand_scheme_slabs', kept);
    expect(slabs.map((row) => [row.action, row.newValues])).toEqual([
      ['insert', { position: 1, target: 1_000 }],
      ['delete', null],
      ['insert', { position: 1, target: 2_000 }],
    ]);
    const benefits = await audit('brand_scheme_benefits', kept);
    expect(benefits.map((row) => row.action)).toEqual(['insert', 'delete', 'insert']);
  });
});

describe('received benefits', () => {
  it('carry exactly the columns of their kind, non-zero and within bounds', async () => {
    const kept = await scheme(a, { status: 'active' });
    await receipt(a, kept);
    await receipt(a, kept, { amountPaise: -10_000, moneyForm: 'payment', reference: null });
    await receipt(a, kept, {
      kind: 'free_goods',
      amountPaise: null,
      moneyForm: null,
      variantId: a.variant,
      units: 2,
      goodsReceiptId: a.grn,
    });
    await receipt(a, kept, {
      kind: 'points',
      amountPaise: null,
      moneyForm: null,
      label: 'Goa trip',
      points: 2,
    });
    expect(await failureMessage(receipt(a, kept, { moneyForm: null }))).toMatch(
      /brand_benefit_receipts_kind/,
    );
    expect(await failureMessage(receipt(a, kept, { goodsReceiptId: a.grn }))).toMatch(
      /brand_benefit_receipts_kind/,
    );
    expect(await failureMessage(receipt(a, kept, { amountPaise: 0 }))).toMatch(
      /brand_benefit_receipts_amounts/,
    );
    expect(await failureMessage(receipt(a, kept, { reference: '' }))).toMatch(
      /brand_benefit_receipts_text/,
    );
    expect(
      await failureMessage(
        receipt(a, kept, {
          kind: 'free_goods',
          amountPaise: null,
          moneyForm: null,
          variantId: a.variant,
          units: 1,
          goodsReceiptId: b.grn,
        }),
      ),
    ).toMatch(/brand_benefit_receipts_goods_receipt_fk/);
  });

  it('are recorded only on an active or closed scheme, never changed or deleted, and audited', async () => {
    const draft = await scheme(a);
    expect(await failureMessage(receipt(a, draft))).toMatch(
      /only on an active or closed scheme, not a draft one/,
    );
    const kept = await scheme(a, { status: 'active' });
    const entry = await receipt(a, kept);
    await setScheme(a, kept, ended(a, 'closed'));
    await receipt(a, kept, { reference: 'CN-LATE' });
    const cancelled = await scheme(a, { status: 'active' });
    await setScheme(a, cancelled, ended(a, 'cancelled'));
    expect(await failureMessage(receipt(a, cancelled))).toMatch(/not a cancelled one/);
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx
            .update(brandBenefitReceipts)
            .set({ amountPaise: 1 })
            .where(eq(brandBenefitReceipts.id, entry)),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await failureMessage(
        connection.db.delete(brandBenefitReceipts).where(eq(brandBenefitReceipts.id, entry)),
      ),
    ).toMatch(/never changed: record a reversal/);
    const rows = await audit('brand_benefit_receipts', entry);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.newValues).toMatchObject({ amount_paise: 50_000, reference: 'CN-881' });
  });

  it('answer a claim of their own scheme only', async () => {
    const kept = await scheme(a, { status: 'active' });
    const other = await scheme(a, { status: 'active' });
    const filed = await claim(a, kept);
    await receipt(a, kept, { claimId: filed });
    expect(await failureMessage(receipt(a, other, { claimId: filed }))).toMatch(
      /brand_benefit_receipts_claim_fk/,
    );
  });
});

describe('brand claims', () => {
  it('are numbered SC-, claim zero or more, and are filed only on an active or closed scheme', async () => {
    const draft = await scheme(a);
    expect(await failureMessage(claim(a, draft))).toMatch(
      /only on an active or closed scheme, not a draft one/,
    );
    const kept = await scheme(a, { status: 'active' });
    expect(await failureMessage(claim(a, kept, { number: 'CL-000001' }))).toMatch(
      /brand_claims_number_format/,
    );
    expect(await failureMessage(claim(a, kept, { claimedPaise: -1 }))).toMatch(
      /brand_claims_claimed/,
    );
    expect(await failureMessage(claim(a, kept, { status: 'settled' }))).toMatch(
      /brand_claims_resolved/,
    );
    expect(await failureMessage(claim(a, kept, { brandReference: '' }))).toMatch(
      /brand_claims_text/,
    );
    const filed = await claim(a, kept);
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.insert(brandClaims).values({
            organizationId: a.org,
            schemeId: kept,
            number: `SC-${String(claimNumbers).padStart(6, '0')}`,
            filedOn: '2027-01-05',
            claimedPaise: 1,
            filedByMemberId: a.member,
          }),
        ),
      ),
    ).toMatch(/brand_claims_number_unique/);
    expect(filed).toBeTruthy();
  });

  it('move forward only, keep what was claimed, close for good and are audited', async () => {
    const kept = await scheme(a, { status: 'active' });
    const filed = await claim(a, kept);
    await setClaim(a, filed, { brandReference: 'APX-CLM-77', note: 'Sent by email' });
    expect(await failureMessage(setClaim(a, filed, { claimedPaise: 1 }))).toMatch(
      /keeps its scheme, number, date and amount/,
    );
    await setClaim(a, filed, { status: 'acknowledged' });
    expect(await failureMessage(setClaim(a, filed, { status: 'filed' }))).toMatch(
      /acknowledged brand claim cannot become filed/,
    );
    await setClaim(a, filed, {
      status: 'settled',
      resolvedAt: new Date(),
      resolvedByMemberId: a.member,
      resolutionNote: 'CN-881 received',
    });
    expect(await failureMessage(setClaim(a, filed, { note: 'Too late' }))).toMatch(
      /a settled brand claim is closed/,
    );
    await setClaim(a, filed, { updatedAt: new Date() });
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.delete(brandClaims).where(eq(brandClaims.id, filed)),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await failureMessage(connection.db.delete(brandClaims).where(eq(brandClaims.id, filed))),
    ).toMatch(/never deleted: withdraw it/);
    const rows = await audit('brand_claims', filed);
    expect(rows.map((row) => row.newValues)).toEqual([
      expect.objectContaining({ claimed_paise: 120_000, status: 'filed' }),
      { brand_reference: 'APX-CLM-77' },
      { status: 'acknowledged' },
      { status: 'settled' },
    ]);

    const other = await claim(a, kept);
    await setClaim(a, other, { status: 'withdrawn', resolvedAt: new Date() });
    const seen = await withTenant(connection.db, b.org, (tx) =>
      tx.select({ id: brandClaims.id }).from(brandClaims),
    );
    expect(seen).toEqual([]);
  });
});
