import { schema, type Transaction } from '@paint/db';
import { GST_RATES_PERCENT, percentToBasisPoints } from '@paint/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import {
  barcode,
  catalogName,
  gstRatePercent,
  hsnCode,
  packSize,
  PRODUCT_TYPES,
  sku,
  UNITS,
} from '../catalog/catalog.schemas.js';
import { choice, decimal, list, optional, required, rupees, text } from './import-cells.js';
import {
  FirstSeen,
  unique,
  type ImportAction,
  type Importer,
  type ParsedRow,
  type RowPlan,
} from './import-types.js';

const { brands, categories, productBarcodes, productVariants, products } = schema;

const row = z
  .object({
    brand: required(catalogName),
    product: required(catalogName),
    type: required(choice(PRODUCT_TYPES)),
    hsn_code: required(hsnCode),
    gst_percent: required(decimal.pipe(gstRatePercent)),
    sku: required(sku),
    pack_size: required(decimal.pipe(packSize)),
    unit: required(choice(UNITS)),
    category: optional(catalogName),
    description: optional(text(1, 2000)),
    mrp: optional(rupees),
    selling_price: optional(rupees),
    barcodes: list.pipe(z.array(barcode).max(10, 'At most 10 barcodes')),
  })
  .transform((cells) => ({
    brand: cells.brand,
    product: cells.product,
    type: cells.type,
    hsnCode: cells.hsn_code,
    gstRateBps: percentToBasisPoints(cells.gst_percent),
    sku: cells.sku,
    packSize: cells.pack_size,
    unit: cells.unit,
    category: cells.category,
    description: cells.description,
    mrpPaise: cells.mrp,
    sellingPricePaise: cells.selling_price,
    barcodes: cells.barcodes,
  }));
type ProductRow = z.output<typeof row>;

/** Product-family details shared by every row (pack) of the same brand and product. */
interface Family {
  readonly key: string;
  readonly first: ParsedRow<ProductRow>;
  category: string | undefined;
  description: string | undefined;
}

/** A row that passed every check, with what it matched. */
interface PlannedRow {
  readonly row: number;
  readonly value: ProductRow;
  readonly family: Family;
  readonly variantId: string | undefined;
  readonly newBarcodes: string[];
  readonly action: ImportAction;
}

const lower = (value: string) => value.toLowerCase();
const familyKey = (value: ProductRow) => `${lower(value.brand)}|${lower(value.product)}`;
const REQUIRED_FAMILY_FIELDS = [
  ['type', 'type'],
  ['hsnCode', 'hsn_code'],
  ['gstRateBps', 'gst_percent'],
] as const;

export const productsImporter: Importer<ProductRow> = {
  kind: 'products',
  title: 'Products and pack sizes',
  permission: 'catalog:manage',
  columns: [
    {
      name: 'brand',
      required: true,
      description: 'Brand; new brands are added',
      example: 'Asian Paints',
    },
    { name: 'product', required: true, description: 'Product family name', example: 'Apex Ultima' },
    {
      name: 'type',
      required: true,
      description: `One of: ${PRODUCT_TYPES.join(', ')}`,
      example: 'exterior_paint',
    },
    { name: 'hsn_code', required: true, description: '4, 6 or 8-digit HSN code', example: '3209' },
    {
      name: 'gst_percent',
      required: true,
      description: `GST rate: ${GST_RATES_PERCENT.join(', ')}`,
      example: '18',
    },
    {
      name: 'sku',
      required: true,
      description: 'Your code for this pack; matches it next time',
      example: 'APX-ULT-1L',
    },
    { name: 'pack_size', required: true, description: 'Pack size, such as 1 or 3.6', example: '1' },
    { name: 'unit', required: true, description: `One of: ${UNITS.join(', ')}`, example: 'l' },
    {
      name: 'category',
      required: false,
      description: 'Category; new ones are added',
      example: 'Exterior emulsions',
    },
    { name: 'description', required: false, description: 'Product description', example: '' },
    { name: 'mrp', required: false, description: 'MRP in rupees', example: '650.00' },
    {
      name: 'selling_price',
      required: false,
      description: 'Selling price in rupees, not above the MRP',
      example: '610.00',
    },
    {
      name: 'barcodes',
      required: false,
      description: 'Barcodes on the pack; separate several with ;',
      example: '8901234567890',
    },
  ],
  row,

  async plan(tx, auth, rows, fail) {
    const families = new Map<string, Family>();
    const skus = new FirstSeen<string>();
    const codes = new FirstSeen<string>();
    const packs = new FirstSeen<string>();
    const checked: (ParsedRow<ProductRow> & { family: Family })[] = [];

    // Checks within the file.
    for (const parsed of rows) {
      const { value } = parsed;
      const problems: [string, string][] = [];
      const skuRow = skus.check(value.sku, parsed.row);
      if (skuRow) problems.push(['sku', `Also on row ${String(skuRow)}`]);
      for (const code of value.barcodes) {
        const codeRow = codes.check(code, parsed.row);
        if (codeRow) problems.push(['barcodes', `${code} is also on row ${String(codeRow)}`]);
      }
      const key = familyKey(value);
      const family = families.get(key);
      if (family) {
        for (const [field, column] of REQUIRED_FAMILY_FIELDS) {
          if (family.first.value[field] !== value[field]) {
            problems.push([
              column,
              `Differs from row ${String(family.first.row)} for the same product`,
            ]);
          }
        }
        for (const field of ['category', 'description'] as const) {
          const known = family[field];
          if (known !== undefined && value[field] !== undefined && known !== value[field]) {
            problems.push([
              field,
              `Differs from row ${String(family.first.row)} for the same product`,
            ]);
          }
        }
      }
      const packRow = packs.check(`${key}|${String(value.packSize)}|${value.unit}`, parsed.row);
      if (packRow) problems.push(['pack_size', `Same pack size as row ${String(packRow)}`]);

      if (problems.length > 0) {
        for (const [column, message] of problems) fail(parsed.row, column, message);
        continue;
      }
      if (family) {
        family.category ??= value.category;
        family.description ??= value.description;
        checked.push({ ...parsed, family });
      } else {
        const created = {
          key,
          first: parsed,
          category: value.category,
          description: value.description,
        };
        families.set(key, created);
        checked.push({ ...parsed, family: created });
      }
    }

    // What already exists.
    const values = checked.map((parsed) => parsed.value);
    const brandRows = await tx
      .select({ id: brands.id, name: brands.name, isActive: brands.isActive })
      .from(brands)
      .where(inArray(sql`lower(${brands.name})`, unique(values.map((v) => lower(v.brand)))));
    const brandIds = new Map(brandRows.map((brand) => [lower(brand.name), brand.id]));
    const categoryRows = await tx
      .select({ id: categories.id, name: categories.name, isActive: categories.isActive })
      .from(categories)
      .where(
        and(
          isNull(categories.parentId),
          inArray(
            sql`lower(${categories.name})`,
            unique(values.flatMap((v) => (v.category ? [lower(v.category)] : []))),
          ),
        ),
      );
    const categoryIds = new Map(
      categoryRows.map((category) => [lower(category.name), category.id]),
    );
    // Inactive brands and categories take no new products (existing ones can still be updated).
    const inactive = new Set(
      [...brandRows, ...categoryRows].filter((row) => !row.isActive).map((row) => row.id),
    );
    const productRows = await tx
      .select()
      .from(products)
      .where(inArray(products.brandId, [...brandIds.values()]));
    const existingProducts = new Map(
      productRows.map((product) => [`${product.brandId}|${lower(product.name)}`, product]),
    );
    const skuOwners = await tx
      .select({ productId: productVariants.productId })
      .from(productVariants)
      .where(
        inArray(
          productVariants.sku,
          values.map((v) => v.sku),
        ),
      );
    const variantRows = await tx
      .select({
        variant: productVariants,
        productName: products.name,
        brandName: brands.name,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(brands, eq(brands.id, products.brandId))
      .where(
        // The matched products' packs, and packs elsewhere that use a SKU from the file.
        inArray(productVariants.productId, [
          ...productRows.map((product) => product.id),
          ...skuOwners.map((owner) => owner.productId),
        ]),
      );
    const variantsBySku = new Map(variantRows.map((row) => [row.variant.sku, row]));
    const barcodeOwners = new Map(
      (
        await tx
          .select({ barcode: productBarcodes.barcode, variantId: productBarcodes.variantId })
          .from(productBarcodes)
          .where(
            inArray(
              productBarcodes.barcode,
              values.flatMap((v) => v.barcodes),
            ),
          )
      ).map((owner) => [owner.barcode, owner.variantId]),
    );

    const existingProduct = (value: ProductRow) => {
      const brandId = brandIds.get(lower(value.brand));
      return brandId ? existingProducts.get(`${brandId}|${lower(value.product)}`) : undefined;
    };
    const familyChanged = (family: Family, product: typeof products.$inferSelect) => {
      const first = family.first.value;
      return (
        product.type !== first.type ||
        product.hsnCode !== first.hsnCode ||
        product.gstRateBps !== first.gstRateBps ||
        (family.category !== undefined &&
          categoryIds.get(lower(family.category)) !== product.categoryId) ||
        (family.description !== undefined && family.description !== product.description)
      );
    };

    // Checks against the database, and what each row will do.
    const planned: PlannedRow[] = [];
    for (const parsed of checked) {
      const { value, family } = parsed;
      const product = existingProduct(value);
      const match = variantsBySku.get(value.sku);
      const problems: [string, string][] = [];
      if (!product && inactive.has(String(brandIds.get(lower(value.brand))))) {
        problems.push(['brand', `${value.brand} is inactive. Reactivate it first.`]);
      }
      const categoryId = family.category && categoryIds.get(lower(family.category));
      if (categoryId && inactive.has(categoryId) && categoryId !== product?.categoryId) {
        problems.push(['category', `${String(family.category)} is inactive. Reactivate it first.`]);
      }
      if (match && match.variant.productId !== product?.id) {
        problems.push([
          'sku',
          `${value.sku} already belongs to ${match.brandName} ${match.productName}`,
        ]);
      }
      const clash = variantRows.find(
        ({ variant }) =>
          variant.productId === product?.id &&
          variant.packSize === value.packSize &&
          variant.unit === value.unit &&
          variant.sku !== value.sku,
      );
      if (clash) {
        problems.push([
          'pack_size',
          `${value.product} already has a ${String(value.packSize)} ${value.unit} pack (SKU ${clash.variant.sku})`,
        ]);
      }
      const newBarcodes: string[] = [];
      for (const code of value.barcodes) {
        const owner = barcodeOwners.get(code);
        if (owner === undefined) newBarcodes.push(code);
        else if (owner !== match?.variant.id) {
          problems.push(['barcodes', `${code} is already on another product`]);
        }
      }
      const mrp = value.mrpPaise ?? match?.variant.mrpPaise;
      const price = value.sellingPricePaise ?? match?.variant.sellingPricePaise;
      if (mrp != null && price != null && price > mrp) {
        problems.push(['selling_price', 'Selling price cannot exceed the MRP']);
      }
      if (problems.length > 0) {
        for (const [column, message] of problems) fail(parsed.row, column, message);
        continue;
      }

      let action: ImportAction = 'create';
      if (match && product) {
        const { variant } = match;
        const changed =
          familyChanged(family, product) ||
          variant.packSize !== value.packSize ||
          variant.unit !== value.unit ||
          (value.mrpPaise !== undefined && value.mrpPaise !== variant.mrpPaise) ||
          (value.sellingPricePaise !== undefined &&
            value.sellingPricePaise !== variant.sellingPricePaise) ||
          newBarcodes.length > 0;
        action = changed ? 'update' : 'unchanged';
      }
      planned.push({
        row: parsed.row,
        value,
        family,
        variantId: match?.variant.id,
        newBarcodes,
        action,
      });
    }

    return {
      rows: planned.map(({ row, value, action }): RowPlan => ({
        row,
        action,
        label: `${value.sku} · ${value.brand} ${value.product} ${String(value.packSize)} ${value.unit}`,
      })),
      apply: (applyTx) =>
        apply(applyTx, auth, planned, { brandIds, categoryIds, existingProduct, familyChanged }),
    };
  },
};

async function apply(
  tx: Transaction,
  auth: AuthContext,
  planned: PlannedRow[],
  known: {
    brandIds: Map<string, string>;
    categoryIds: Map<string, string>;
    existingProduct: (value: ProductRow) => typeof products.$inferSelect | undefined;
    familyChanged: (family: Family, product: typeof products.$inferSelect) => boolean;
  },
): Promise<void> {
  const organizationId = auth.organization.id;
  const { brandIds, categoryIds } = known;
  const productIds = new Map<string, string>();

  for (const { value, family } of planned) {
    const brandKey = lower(value.brand);
    if (!brandIds.has(brandKey)) {
      const [brand] = await tx
        .insert(brands)
        .values({ organizationId, name: value.brand })
        .returning({ id: brands.id });
      brandIds.set(brandKey, String(brand?.id));
    }
    const category = family.category;
    if (category !== undefined && !categoryIds.has(lower(category))) {
      const [created] = await tx
        .insert(categories)
        .values({ organizationId, name: category })
        .returning({ id: categories.id });
      categoryIds.set(lower(category), String(created?.id));
    }
    if (productIds.has(family.key)) continue;

    const details = {
      type: family.first.value.type,
      hsnCode: family.first.value.hsnCode,
      gstRateBps: family.first.value.gstRateBps,
      ...(category === undefined ? {} : { categoryId: categoryIds.get(lower(category)) }),
      ...(family.description === undefined ? {} : { description: family.description }),
    };
    const product = known.existingProduct(value);
    if (product) {
      if (known.familyChanged(family, product)) {
        await tx
          .update(products)
          .set({ ...details, updatedAt: sql`now()` })
          .where(eq(products.id, product.id));
      }
      productIds.set(family.key, product.id);
    } else {
      const [created] = await tx
        .insert(products)
        .values({
          organizationId,
          brandId: String(brandIds.get(brandKey)),
          name: value.product,
          ...details,
        })
        .returning({ id: products.id });
      productIds.set(family.key, String(created?.id));
    }
  }

  for (const { value, family, variantId, newBarcodes, action } of planned) {
    const prices = {
      ...(value.mrpPaise === undefined ? {} : { mrpPaise: value.mrpPaise }),
      ...(value.sellingPricePaise === undefined
        ? {}
        : { sellingPricePaise: value.sellingPricePaise }),
    };
    let id = variantId;
    if (id === undefined) {
      const [created] = await tx
        .insert(productVariants)
        .values({
          organizationId,
          productId: String(productIds.get(family.key)),
          sku: value.sku,
          packSize: value.packSize,
          unit: value.unit,
          ...prices,
        })
        .returning({ id: productVariants.id });
      id = String(created?.id);
    } else if (action === 'update') {
      await tx
        .update(productVariants)
        .set({ packSize: value.packSize, unit: value.unit, ...prices, updatedAt: sql`now()` })
        .where(eq(productVariants.id, id));
    }
    if (newBarcodes.length > 0) {
      const variant = id;
      await tx
        .insert(productBarcodes)
        .values(newBarcodes.map((code) => ({ organizationId, barcode: code, variantId: variant })));
    }
  }
}
