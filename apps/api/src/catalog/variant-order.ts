import { schema } from '@paint/db';
import { sql, type SQL } from 'drizzle-orm';

const { productVariants } = schema;

/**
 * Variants in the order people read them: by unit and size, then labelled packs of one
 * size by the first number in the label ("Grit 80" before "Grit 120"), then by name.
 */
export const variantOrder = (): SQL[] => [
  sql`${productVariants.unit}`,
  sql`${productVariants.packSize}`,
  sql`(regexp_match(${productVariants.label}, '[0-9]+(?:\\.[0-9]+)?'))[1]::numeric nulls first`,
  sql`lower(${productVariants.label}) nulls first`,
];
