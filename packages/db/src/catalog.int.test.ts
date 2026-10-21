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

const { brands, categories, organizations, productBarcodes, productVariants, products } = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let orgA: string;
let orgB: string;
let brandA: string;
let brandB: string;
let productA: string;
let variantA: string;

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

const apex = (organizationId: string, brandId: string) => ({
  organizationId,
  brandId,
  name: 'Apex Ultima',
  type: 'exterior_paint' as const,
  hsnCode: '3209',
  gstRateBps: 1800,
});

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
    productBarcodes,
    productVariants,
    products,
    categories,
    brands,
    organizations,
  ]) {
    await db.delete(table);
  }
  orgA = id(await db.insert(organizations).values({ name: 'ABC Paints' }).returning());
  orgB = id(await db.insert(organizations).values({ name: 'XYZ Paints' }).returning());
  brandA = id(
    await db.insert(brands).values({ organizationId: orgA, name: 'Asian Paints' }).returning(),
  );
  brandB = id(
    await db.insert(brands).values({ organizationId: orgB, name: 'Asian Paints' }).returning(),
  );
  productA = id(await db.insert(products).values(apex(orgA, brandA)).returning());
  variantA = id(
    await db
      .insert(productVariants)
      .values({
        organizationId: orgA,
        productId: productA,
        sku: 'AP-ULT-20L',
        packSize: 20,
        unit: 'l',
        mrpPaise: 1_250_000,
        sellingPricePaise: 1_199_900,
      })
      .returning(),
  );
  await db
    .insert(productBarcodes)
    .values({ organizationId: orgA, barcode: '4006381333931', variantId: variantA });
});

describe('catalog: tenant isolation', () => {
  it('keeps brands, products, variants and barcodes inside their business', async () => {
    const seen = (org: string) =>
      withTenant(connection.db, org, async (tx) => ({
        brands: (await tx.select().from(brands)).length,
        products: (await tx.select().from(products)).length,
        variants: (await tx.select().from(productVariants)).length,
        barcodes: (await tx.select().from(productBarcodes)).length,
      }));

    expect(await seen(orgA)).toEqual({ brands: 1, products: 1, variants: 1, barcodes: 1 });
    expect(await seen(orgB)).toEqual({ brands: 1, products: 0, variants: 0, barcodes: 0 });
  });

  it("rejects a product using another business's brand", async () => {
    const message = await failureMessage(connection.db.insert(products).values(apex(orgA, brandB)));

    expect(message).toMatch(/products_brand_fk/);
  });

  it('reads pack sizes and prices back as numbers', async () => {
    const [variant] = await connection.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, variantA));

    expect(variant).toMatchObject({
      packSize: 20,
      mrpPaise: 1_250_000,
      sellingPricePaise: 1_199_900,
    });
  });
});

describe('catalog: uniqueness', () => {
  it('treats brand names that differ only in case as the same brand', async () => {
    const message = await failureMessage(
      connection.db.insert(brands).values({ organizationId: orgA, name: 'ASIAN PAINTS' }),
    );

    expect(message).toMatch(/brands_organization_name_unique/);
  });

  it('allows one product name per brand, ignoring case', async () => {
    const message = await failureMessage(
      connection.db.insert(products).values({ ...apex(orgA, brandA), name: 'apex ultima' }),
    );

    expect(message).toMatch(/products_organization_brand_name_unique/);
  });

  it('allows the same category name under different parents, but not twice at one level', async () => {
    const { db } = connection;
    const interior = id(
      await db.insert(categories).values({ organizationId: orgA, name: 'Interior' }).returning(),
    );
    const exterior = id(
      await db.insert(categories).values({ organizationId: orgA, name: 'Exterior' }).returning(),
    );
    await db.insert(categories).values([
      { organizationId: orgA, name: 'Emulsions', parentId: interior },
      { organizationId: orgA, name: 'Emulsions', parentId: exterior },
    ]);

    const topLevel = await failureMessage(
      db.insert(categories).values({ organizationId: orgA, name: 'interior' }),
    );
    const sameParent = await failureMessage(
      db.insert(categories).values({ organizationId: orgA, name: 'EMULSIONS', parentId: interior }),
    );

    expect(topLevel).toMatch(/categories_organization_parent_name_unique/);
    expect(sameParent).toMatch(/categories_organization_parent_name_unique/);
  });

  it('allows one variant per pack size and one use of each SKU and barcode', async () => {
    const { db } = connection;
    const base = { organizationId: orgA, productId: productA, unit: 'l' as const };

    const samePack = await failureMessage(
      db.insert(productVariants).values({ ...base, sku: 'AP-ULT-20L-B', packSize: 20 }),
    );
    const sameSku = await failureMessage(
      db.insert(productVariants).values({ ...base, sku: 'AP-ULT-20L', packSize: 10 }),
    );
    const otherVariant = id(
      await db
        .insert(productVariants)
        .values({ ...base, sku: 'AP-ULT-10L', packSize: 10 })
        .returning(),
    );
    const sameBarcode = await failureMessage(
      db
        .insert(productBarcodes)
        .values({ organizationId: orgA, barcode: '4006381333931', variantId: otherVariant }),
    );

    expect(samePack).toMatch(/product_variants_product_pack_label_unique/);
    expect(sameSku).toMatch(/product_variants_organization_sku_unique/);
    expect(sameBarcode).toMatch(/product_barcodes_pkey|duplicate key/);
  });
});

describe('catalog: variant labels', () => {
  const piece = (sku: string, label: string | null, productId = productA) => ({
    organizationId: orgA,
    productId,
    sku,
    packSize: 1,
    unit: 'piece' as const,
    label,
  });

  it('tells same-sized packs apart by label, once each, ignoring case', async () => {
    const { db } = connection;
    await db
      .insert(productVariants)
      .values([piece('BR-1', '1 inch'), piece('BR-2', '2 inch'), piece('BR-0', null)]);

    const sameLabel = await failureMessage(
      db.insert(productVariants).values(piece('BR-2B', '2 INCH')),
    );
    const secondUnlabelled = await failureMessage(
      db.insert(productVariants).values(piece('BR-0B', null)),
    );

    expect(sameLabel).toMatch(/product_variants_product_pack_label_unique/);
    expect(secondUnlabelled).toMatch(/product_variants_product_pack_label_unique/);
    // A different product, or a different size, may use the same label.
    const other = id(
      await db
        .insert(products)
        .values({ ...apex(orgA, brandA), name: 'Roller' })
        .returning(),
    );
    await db
      .insert(productVariants)
      .values([piece('RL-2', '2 inch', other), { ...piece('BR-2-PK', '2 inch'), packSize: 6 }]);
    const labels = await db
      .select({ sku: productVariants.sku, label: productVariants.label })
      .from(productVariants)
      .where(eq(productVariants.label, '2 inch'));
    expect(labels.map((row) => row.sku).sort()).toEqual(['BR-2', 'BR-2-PK', 'RL-2']);
  });

  it.each([[''], [' 2 inch'], ['2 inch '], ['x'.repeat(41)]])(
    'refuses the label %j: blank, untrimmed or over 40 characters',
    async (label) => {
      const message = await failureMessage(
        connection.db.insert(productVariants).values(piece('BR-X', label)),
      );

      expect(message).toMatch(/product_variants_label_format/);
    },
  );

  it('keeps labelled variants inside their business', async () => {
    await connection.db.insert(productVariants).values(piece('BR-1', '1 inch'));
    const labels = (org: string) =>
      withTenant(connection.db, org, async (tx) =>
        (await tx.select({ label: productVariants.label }).from(productVariants)).map(
          (row) => row.label,
        ),
      );

    expect((await labels(orgA)).sort()).toEqual(['1 inch', null]);
    expect(await labels(orgB)).toEqual([]);
  });
});

describe('catalog: rules', () => {
  it('never lets the selling price exceed the MRP', async () => {
    const message = await failureMessage(
      connection.db
        .update(productVariants)
        .set({ sellingPricePaise: 1_250_001 })
        .where(eq(productVariants.id, variantA)),
    );

    expect(message).toMatch(/product_variants_price_within_mrp/);
  });

  it.each([
    [{ sku: 'ap-ult-1l' }, /product_variants_sku_format/],
    [{ sku: 'A' }, /product_variants_sku_format/],
    [{ packSize: 0 }, /product_variants_pack_size_positive/],
    [{ mrpPaise: -1 }, /product_variants_prices_not_negative/],
    [{ densityGPerMl: 0 }, /product_variants_density_range/],
    [{ densityGPerMl: 25.5 }, /product_variants_density_range/],
  ])('rejects variant %o', async (values, constraint) => {
    const message = await failureMessage(
      connection.db.insert(productVariants).values({
        organizationId: orgA,
        productId: productA,
        sku: 'AP-ULT-1L',
        packSize: 1,
        unit: 'l',
        ...values,
      }),
    );

    expect(message).toMatch(constraint);
  });

  it.each([
    [{ hsnCode: '320' }, /products_hsn_format/],
    [{ gstRateBps: 10_001 }, /products_gst_rate_range/],
  ])('rejects product %o', async (values, constraint) => {
    const message = await failureMessage(
      connection.db.insert(products).values({ ...apex(orgA, brandA), name: 'Other', ...values }),
    );

    expect(message).toMatch(constraint);
  });

  it('stops a category being its own parent', async () => {
    const category = id(
      await connection.db
        .insert(categories)
        .values({ organizationId: orgA, name: 'Loop' })
        .returning(),
    );

    const message = await failureMessage(
      connection.db
        .update(categories)
        .set({ parentId: category })
        .where(eq(categories.id, category)),
    );

    expect(message).toMatch(/categories_not_own_parent/);
  });

  it('removes variants and barcodes with their product, but keeps brands in use', async () => {
    const brandInUse = await failureMessage(
      connection.db.delete(brands).where(eq(brands.id, brandA)),
    );
    await connection.db.delete(products).where(eq(products.id, productA));

    expect(brandInUse).toMatch(/products_brand_fk/);
    expect(
      await connection.db
        .select()
        .from(productVariants)
        .where(eq(productVariants.productId, productA)),
    ).toEqual([]);
    expect(
      await connection.db
        .select()
        .from(productBarcodes)
        .where(eq(productBarcodes.variantId, variantA)),
    ).toEqual([]);
  });
});
