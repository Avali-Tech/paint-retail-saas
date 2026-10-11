import { BadRequestException } from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import { and, eq, ne, sql, type SQL } from 'drizzle-orm';

const { stores, taxCategories } = schema;

/** Today's calendar date in India, from the database clock. */
export const indiaToday = sql`(now() at time zone 'Asia/Kolkata')::date`;

/**
 * The rate a category charges today: the latest period already started, or the
 * first one if none has (a category whose only rate starts later). Every category
 * has a rate, and a period is closed only when the next one is added.
 */
const categoryRateBps = (categoryId: SQL) =>
  sql<number>`(
    select tr.rate_bps from tax_rates tr
    where tr.tax_category_id = ${categoryId}
    order by tr.effective_from > ${indiaToday}, abs(tr.effective_from - ${indiaToday})
    limit 1
  )`;

// Qualified by hand: Drizzle leaves a single table's columns unqualified, and inside
// the subquery an unqualified "id" would be the rate's own.
/** Today's rate of the tax category in the row (select from tax_categories). */
export const taxCategoryRateBps = categoryRateBps(sql.raw('"tax_categories"."id"'));
/** Today's rate of the product's tax category (select from products). */
export const productTaxRateBps = categoryRateBps(sql.raw('"products"."tax_category_id"'));

/** A 400 naming the field at fault, shaped like the validation pipe's answers. */
export function fieldError(path: string, message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    message: 'Invalid request',
    issues: [{ path, message }],
  });
}

/** True once any open store is registered for GST (regular or composition). */
export async function isGstRegistered(tx: Transaction): Promise<boolean> {
  const [store] = await tx
    .select({ id: stores.id })
    .from(stores)
    .where(and(ne(stores.registrationType, 'unregistered'), eq(stores.isActive, true)))
    .limit(1);
  return store !== undefined;
}

/**
 * The tax category a new or changed product gets, with today's rate. Without a
 * choice it is the business's default, until the business is registered for GST:
 * from then on a product needs one picked deliberately.
 */
export async function chooseTaxCategory(
  tx: Transaction,
  taxCategoryId: string | undefined,
): Promise<{ id: string; rateBps: number }> {
  if (taxCategoryId === undefined && (await isGstRegistered(tx))) {
    throw fieldError('taxCategoryId', 'Choose a tax category: the business is registered for GST');
  }
  const [category] = await tx
    .select({
      id: taxCategories.id,
      isActive: taxCategories.isActive,
      rateBps: taxCategoryRateBps,
    })
    .from(taxCategories)
    .where(
      taxCategoryId === undefined
        ? eq(taxCategories.isDefault, true)
        : eq(taxCategories.id, taxCategoryId),
    );
  if (!category) throw new BadRequestException('Unknown tax category');
  if (!category.isActive) {
    throw new BadRequestException('This tax category is inactive. Reactivate it first.');
  }
  return { id: category.id, rateBps: category.rateBps };
}
