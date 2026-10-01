import { z } from 'zod';

const threeDecimals = (value: number) => Math.abs(Math.round(value * 1000) - value * 1000) < 1e-6;
const level = z.number().min(0).max(1_000_000_000).refine(threeDecimals, 'Use at most 3 decimals');

export const saveRulesSchema = z.object({
  rules: z
    .array(
      z
        .object({
          storeId: z.uuid(),
          variantId: z.uuid(),
          minQuantity: level,
          reorderLevel: level,
          maxQuantity: level.refine((value) => value > 0, 'The maximum must be more than zero'),
        })
        .refine(
          (rule) => rule.minQuantity <= rule.reorderLevel && rule.reorderLevel <= rule.maxQuantity,
          { message: 'Use minimum ≤ reorder level ≤ maximum' },
        ),
    )
    .min(1)
    .max(500),
});
export type SaveRulesInput = z.output<typeof saveRulesSchema>;

const paging = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

export const listRulesSchema = z.object({
  storeId: z.uuid().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  ...paging,
});
export type ListRulesQuery = z.output<typeof listRulesSchema>;

export const lowStockSchema = z.object({ storeId: z.uuid().optional(), ...paging });
export type LowStockQuery = z.output<typeof lowStockSchema>;

export const slowMoversSchema = z.object({
  storeId: z.uuid().optional(),
  /** No sale or transfer out for at least this many days. */
  days: z.coerce.number().int().min(1).max(3650).default(90),
  ...paging,
});
export type SlowMoversQuery = z.output<typeof slowMoversSchema>;
