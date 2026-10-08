import { schema, type Transaction } from '@paint/db';
import type { GstRate } from '@paint/shared';
import { eq, inArray } from 'drizzle-orm';

const { taxCategories, taxRates } = schema;

/**
 * Every dated rate of the given tax categories, as the GST engine reads them.
 * A 0 % category is exempt when it is the Exempt default, nil-rated otherwise.
 */
export async function gstRatesFor(
  tx: Transaction,
  categoryIds: readonly string[],
): Promise<GstRate[]> {
  const rows = await tx
    .select({
      categoryCode: taxRates.taxCategoryId,
      key: taxCategories.key,
      rateBasisPoints: taxRates.rateBps,
      effectiveFrom: taxRates.effectiveFrom,
      effectiveTo: taxRates.effectiveTo,
    })
    .from(taxRates)
    .innerJoin(taxCategories, eq(taxCategories.id, taxRates.taxCategoryId))
    .where(inArray(taxRates.taxCategoryId, [...categoryIds]));
  return rows.map(({ key, ...rate }) => ({
    ...rate,
    nature: rate.rateBasisPoints > 0 ? 'taxable' : key === 'exempt' ? 'exempt' : 'nil_rated',
    cessBasisPoints: 0,
  }));
}
