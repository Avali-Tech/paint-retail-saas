import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  isCheckViolation,
  schema,
  uniqueViolationConstraint,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import { basisPointsToPercent } from '@paint/shared';
import { and, count, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { chooseTaxCategory, productTaxRateBps } from '../tax/tax-lookups.js';
import { containsPattern } from '../parties/party-access.js';
import type {
  CreateProductInput,
  ListProductsQuery,
  UpdateProductInput,
  UpdateVariantInput,
  VariantInput,
} from './catalog.schemas.js';
import { variantOrder } from './variant-order.js';

const { brands, categories, productBarcodes, productVariants, products, taxCategories } = schema;

/** Friendly messages for duplicates, keyed by the unique constraint that caught them. */
const CONFLICTS: Record<string, string> = {
  brands_organization_name_unique: 'A brand with this name already exists',
  categories_organization_parent_name_unique: 'A category with this name already exists here',
  products_organization_brand_name_unique: 'This brand already has a product with this name',
  product_variants_organization_sku_unique: 'This SKU is already used by another product',
  product_variants_product_pack_label_unique:
    'This product already has a variant of this size and label',
  product_barcodes_organization_id_barcode_pk: 'This barcode is already used by another product',
};

type BrandRow = typeof brands.$inferSelect;
type CategoryRow = typeof categories.$inferSelect;
type VariantRow = typeof productVariants.$inferSelect;

export interface BrandView {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
}
export interface CategoryView {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly isActive: boolean;
}
export interface VariantView {
  readonly id: string;
  readonly sku: string;
  readonly packSize: number;
  readonly unit: VariantRow['unit'];
  /** Tells same-sized packs apart, e.g. "2 inch"; null when there is one pack of a size. */
  readonly label: string | null;
  readonly mrpPaise: number | null;
  readonly sellingPricePaise: number | null;
  readonly isActive: boolean;
  readonly barcodes: string[];
}
export interface ProductView {
  readonly id: string;
  readonly name: string;
  readonly type: (typeof products.$inferSelect)['type'];
  readonly description: string | null;
  readonly hsnCode: string;
  /** Today's rate of its tax category. */
  readonly gstRatePercent: number;
  /** Null only for a product the previous release created during a rollout. */
  readonly taxCategory: { readonly id: string; readonly name: string } | null;
  readonly isActive: boolean;
  readonly brand: { readonly id: string; readonly name: string };
  readonly category: CategoryView | null;
  readonly variants: VariantView[];
}
export interface ProductPage {
  readonly items: ProductView[];
  readonly total: number;
}
export interface LookupResult {
  readonly product: ProductView;
  readonly variant: VariantView;
}

const toBrand = ({ id, name, isActive }: BrandRow): BrandView => ({ id, name, isActive });
const toCategory = ({ id, name, parentId, isActive }: CategoryRow): CategoryView => ({
  id,
  name,
  parentId,
  isActive,
});

const INACTIVE_BRAND = 'This brand is inactive. Reactivate it first.';
const INACTIVE_CATEGORY = 'This category is inactive. Reactivate it first.';

const toVariant = (
  variant: VariantRow,
  barcodeRows: readonly { variantId: string; barcode: string }[],
): VariantView => ({
  id: variant.id,
  sku: variant.sku,
  packSize: variant.packSize,
  unit: variant.unit,
  label: variant.label,
  mrpPaise: variant.mrpPaise,
  sellingPricePaise: variant.sellingPricePaise,
  isActive: variant.isActive,
  barcodes: barcodeRows
    .filter((row) => row.variantId === variant.id)
    .map((row) => row.barcode)
    .sort(),
});

@Injectable()
export class CatalogService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  // Brands ------------------------------------------------------------------

  listBrands(auth: AuthContext): Promise<BrandView[]> {
    return this.tenant(auth, async (tx) =>
      (
        await tx
          .select()
          .from(brands)
          .orderBy(sql`lower(${brands.name})`)
      ).map(toBrand),
    );
  }

  createBrand(auth: AuthContext, input: { name: string }): Promise<BrandView> {
    return this.tenant(auth, async (tx) => {
      const [brand] = (await tx
        .insert(brands)
        .values({ organizationId: auth.organization.id, name: input.name })
        .returning()) as [BrandRow];
      return toBrand(brand);
    });
  }

  updateBrand(
    auth: AuthContext,
    brandId: string,
    input: { name?: string; isActive?: boolean },
  ): Promise<BrandView> {
    return this.tenant(auth, async (tx) => {
      const [brand] = await tx
        .update(brands)
        .set({ ...input, updatedAt: sql`now()` })
        .where(eq(brands.id, brandId))
        .returning();
      if (!brand) throw new NotFoundException('Brand not found');
      return toBrand(brand);
    });
  }

  // Categories --------------------------------------------------------------

  listCategories(auth: AuthContext): Promise<CategoryView[]> {
    return this.tenant(auth, async (tx) =>
      (
        await tx
          .select()
          .from(categories)
          .orderBy(sql`lower(${categories.name})`)
      ).map(toCategory),
    );
  }

  createCategory(
    auth: AuthContext,
    input: { name: string; parentId?: string },
  ): Promise<CategoryView> {
    return this.tenant(auth, async (tx) => {
      if (input.parentId) {
        const [parent] = await tx
          .select()
          .from(categories)
          .where(eq(categories.id, input.parentId));
        if (!parent) throw new BadRequestException('Unknown parent category');
        if (!parent.isActive) throw new BadRequestException(INACTIVE_CATEGORY);
        if (parent.parentId) {
          throw new BadRequestException('Subcategories cannot have their own subcategories');
        }
      }
      const [category] = (await tx
        .insert(categories)
        .values({ organizationId: auth.organization.id, ...input })
        .returning()) as [CategoryRow];
      return toCategory(category);
    });
  }

  /**
   * Renames, deactivates or reactivates a category. An inactive category (or
   * one under an inactive parent) keeps its products but takes no new ones.
   */
  updateCategory(
    auth: AuthContext,
    categoryId: string,
    input: { name?: string; isActive?: boolean },
  ): Promise<CategoryView> {
    return this.tenant(auth, async (tx) => {
      const [category] = await tx
        .update(categories)
        .set({ ...input, updatedAt: sql`now()` })
        .where(eq(categories.id, categoryId))
        .returning();
      if (!category) throw new NotFoundException('Category not found');
      return toCategory(category);
    });
  }

  // Products ----------------------------------------------------------------

  listProducts(auth: AuthContext, query: ListProductsQuery): Promise<ProductPage> {
    return this.tenant(auth, async (tx) => {
      const where = and(
        query.includeInactive ? undefined : eq(products.isActive, true),
        query.brandId ? eq(products.brandId, query.brandId) : undefined,
        query.categoryId
          ? or(
              eq(products.categoryId, query.categoryId),
              inArray(
                products.categoryId,
                tx
                  .select({ id: categories.id })
                  .from(categories)
                  .where(eq(categories.parentId, query.categoryId)),
              ),
            )
          : undefined,
        query.type ? eq(products.type, query.type) : undefined,
        query.q ? this.matching(tx, query.q) : undefined,
      );
      const rows = await tx
        .select({ id: products.id })
        .from(products)
        .innerJoin(brands, eq(brands.id, products.brandId))
        .where(where)
        .orderBy(sql`lower(${brands.name})`, sql`lower(${products.name})`, products.id)
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx
        .select({ total: count() })
        .from(products)
        .innerJoin(brands, eq(brands.id, products.brandId))
        .where(where);
      return {
        items: await this.productViews(
          tx,
          rows.map((row) => row.id),
        ),
        total: Number(totals?.total),
      };
    });
  }

  getProduct(auth: AuthContext, productId: string): Promise<ProductView> {
    return this.tenant(auth, (tx) => this.productView(tx, productId));
  }

  createProduct(auth: AuthContext, input: CreateProductInput): Promise<ProductView> {
    const { variants, taxCategoryId, ...fields } = input;
    const productId = randomUUID();
    return this.tenant(auth, async (tx) => {
      await this.assertBrand(tx, fields.brandId);
      await this.assertCategory(tx, fields.categoryId ?? null);
      const tax = await chooseTaxCategory(tx, taxCategoryId);
      await tx.insert(products).values({
        id: productId,
        organizationId: auth.organization.id,
        ...fields,
        taxCategoryId: tax.id,
        gstRateBps: tax.rateBps,
      });
      for (const variant of variants) await this.insertVariant(tx, auth, productId, variant);
      return this.productView(tx, productId);
    });
  }

  updateProduct(
    auth: AuthContext,
    productId: string,
    input: UpdateProductInput,
  ): Promise<ProductView> {
    const { taxCategoryId, ...fields } = input;
    return this.tenant(auth, async (tx) => {
      const [current] = await tx
        .select({ brandId: products.brandId, categoryId: products.categoryId })
        .from(products)
        .where(eq(products.id, productId));
      if (!current) throw new NotFoundException('Product not found');
      // A product may not move to, or come back to life under, an inactive brand or category.
      const reactivating = fields.isActive === true;
      if (fields.brandId || reactivating) {
        await this.assertBrand(tx, fields.brandId ?? current.brandId);
      }
      if (fields.categoryId || reactivating) {
        await this.assertCategory(
          tx,
          fields.categoryId === undefined ? current.categoryId : fields.categoryId,
        );
      }
      const tax =
        taxCategoryId === undefined ? undefined : await chooseTaxCategory(tx, taxCategoryId);
      await tx
        .update(products)
        .set({
          ...fields,
          ...(tax && { taxCategoryId: tax.id, gstRateBps: tax.rateBps }),
          updatedAt: sql`now()`,
        })
        .where(eq(products.id, productId));
      return this.productView(tx, productId);
    });
  }

  addVariant(auth: AuthContext, productId: string, input: VariantInput): Promise<ProductView> {
    return this.tenant(auth, async (tx) => {
      await this.productView(tx, productId);
      await this.insertVariant(tx, auth, productId, input);
      return this.productView(tx, productId);
    });
  }

  updateVariant(
    auth: AuthContext,
    variantId: string,
    input: UpdateVariantInput,
  ): Promise<ProductView> {
    const { barcodes, ...fields } = input;
    return this.tenant(auth, async (tx) => {
      const [variant] = await tx
        .update(productVariants)
        .set({ ...fields, updatedAt: sql`now()` })
        .where(eq(productVariants.id, variantId))
        .returning();
      if (!variant) throw new NotFoundException('Variant not found');
      if (barcodes) {
        await tx.delete(productBarcodes).where(eq(productBarcodes.variantId, variantId));
        await this.insertBarcodes(tx, auth, variantId, barcodes);
      }
      return this.productView(tx, variant.productId);
    });
  }

  /**
   * Finds the variant for a scanned barcode or a typed SKU (for the counter).
   * Discontinued packs and products are left out unless `includeInactive`.
   */
  lookup(auth: AuthContext, code: string, includeInactive: boolean): Promise<LookupResult> {
    return this.tenant(auth, async (tx) => {
      const [byBarcode] = await tx
        .select({ variantId: productBarcodes.variantId })
        .from(productBarcodes)
        .where(eq(productBarcodes.barcode, code));
      const [variant] = await tx
        .select()
        .from(productVariants)
        .where(
          byBarcode
            ? eq(productVariants.id, byBarcode.variantId)
            : eq(productVariants.sku, code.toUpperCase()),
        );
      if (!variant) throw new NotFoundException('No product with this barcode or SKU');
      const barcodeRows = await tx
        .select()
        .from(productBarcodes)
        .where(eq(productBarcodes.variantId, variant.id));
      const product = await this.productView(tx, variant.productId);
      if (!includeInactive && !(variant.isActive && product.isActive)) {
        throw new NotFoundException('This product is discontinued');
      }
      return { product, variant: toVariant(variant, barcodeRows) };
    });
  }

  // Helpers -----------------------------------------------------------------

  /** Runs `work` in tenant scope, turning duplicate and price errors into clear 409 / 400 answers. */
  private async tenant<T>(auth: AuthContext, work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await withTenant(this.connection.db, auth.organization.id, work);
    } catch (error) {
      const constraint = uniqueViolationConstraint(error);
      const conflict = constraint === null ? undefined : CONFLICTS[constraint];
      if (conflict) throw new ConflictException(conflict);
      if (isCheckViolation(error, ['product_variants_price_within_mrp'])) {
        throw new BadRequestException('Selling price cannot exceed the MRP');
      }
      throw error;
    }
  }

  private matching(tx: Transaction, q: string): SQL | undefined {
    const pattern = containsPattern(q);
    return or(
      ilike(products.name, pattern),
      ilike(brands.name, pattern),
      inArray(
        products.id,
        tx
          .select({ id: productVariants.productId })
          .from(productVariants)
          .leftJoin(productBarcodes, eq(productBarcodes.variantId, productVariants.id))
          .where(
            or(
              ilike(productVariants.sku, pattern),
              ilike(productVariants.label, pattern),
              eq(productBarcodes.barcode, q),
            ),
          ),
      ),
    );
  }

  /** The brand exists and is active (products cannot be added to an inactive one). */
  private async assertBrand(tx: Transaction, brandId: string): Promise<void> {
    const [brand] = await tx
      .select({ isActive: brands.isActive })
      .from(brands)
      .where(eq(brands.id, brandId));
    if (!brand) throw new BadRequestException('Unknown brand');
    if (!brand.isActive) throw new BadRequestException(INACTIVE_BRAND);
  }

  /** The category, and its parent if it has one, exist and are active. */
  private async assertCategory(tx: Transaction, categoryId: string | null): Promise<void> {
    if (categoryId === null) return;
    const parent = alias(categories, 'parent');
    const [category] = await tx
      .select({ isActive: categories.isActive, parentActive: parent.isActive })
      .from(categories)
      .leftJoin(parent, eq(parent.id, categories.parentId))
      .where(eq(categories.id, categoryId));
    if (!category) throw new BadRequestException('Unknown category');
    if (!category.isActive || category.parentActive === false) {
      throw new BadRequestException(INACTIVE_CATEGORY);
    }
  }

  private async insertVariant(
    tx: Transaction,
    auth: AuthContext,
    productId: string,
    { barcodes, ...variant }: VariantInput,
  ): Promise<void> {
    const variantId = randomUUID();
    await tx.insert(productVariants).values({
      id: variantId,
      organizationId: auth.organization.id,
      productId,
      ...variant,
    });
    await this.insertBarcodes(tx, auth, variantId, barcodes);
  }

  private async insertBarcodes(
    tx: Transaction,
    auth: AuthContext,
    variantId: string,
    barcodes: readonly string[],
  ): Promise<void> {
    if (barcodes.length === 0) return;
    await tx
      .insert(productBarcodes)
      .values(
        barcodes.map((barcode) => ({ organizationId: auth.organization.id, barcode, variantId })),
      );
  }

  private async productView(tx: Transaction, productId: string): Promise<ProductView> {
    const [view] = await this.productViews(tx, [productId]);
    if (!view) throw new NotFoundException('Product not found');
    return view;
  }

  /** Products with brand, category, variants and barcodes, in the order of `ids`. */
  private async productViews(tx: Transaction, ids: string[]): Promise<ProductView[]> {
    const rows = await tx
      .select({
        product: products,
        brand: brands,
        category: categories,
        taxCategoryName: taxCategories.name,
        rateBps: sql<number>`coalesce(${productTaxRateBps}, ${products.gstRateBps})`,
      })
      .from(products)
      .innerJoin(brands, eq(brands.id, products.brandId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .leftJoin(taxCategories, eq(taxCategories.id, products.taxCategoryId))
      .where(inArray(products.id, ids));
    const variants = await tx
      .select()
      .from(productVariants)
      .where(inArray(productVariants.productId, ids))
      .orderBy(...variantOrder());
    const barcodeRows = await tx
      .select()
      .from(productBarcodes)
      .where(
        inArray(
          productBarcodes.variantId,
          variants.map((variant) => variant.id),
        ),
      );

    const views = rows.map(
      ({ product, brand, category, taxCategoryName, rateBps }): ProductView => ({
        id: product.id,
        name: product.name,
        type: product.type,
        description: product.description,
        hsnCode: product.hsnCode,
        gstRatePercent: basisPointsToPercent(rateBps),
        taxCategory:
          product.taxCategoryId === null
            ? null
            : { id: product.taxCategoryId, name: String(taxCategoryName) },
        isActive: product.isActive,
        brand: { id: brand.id, name: brand.name },
        category: category ? toCategory(category) : null,
        variants: variants
          .filter((variant) => variant.productId === product.id)
          .map((variant) => toVariant(variant, barcodeRows)),
      }),
    );
    return ids.flatMap((id) => views.filter((view) => view.id === id));
  }
}
