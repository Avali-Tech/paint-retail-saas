import { schema } from '@paint/db';
import { z } from 'zod';

export const VARIANCE_REASONS = schema.varianceReason.enumValues;
export const COUNT_STATUSES = schema.stockCountStatus.enumValues;

const threeDecimals = (value: number) => Math.abs(Math.round(value * 1000) - value * 1000) < 1e-6;

export const startCountSchema = z
  .object({
    storeId: z.uuid(),
    scope: z.enum(['full', 'brand', 'category']).default('full'),
    /** The brand or category to count, for a partial count. */
    scopeId: z.uuid().optional(),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .refine((body) => (body.scope === 'full') === (body.scopeId === undefined), {
    path: ['scopeId'],
    message: 'Give a brand or category id for a partial count, and none for a full count',
  });
export type StartCountInput = z.output<typeof startCountSchema>;

/**
 * Counted quantities, in batches (a phone can sync many scans at once). Each
 * entry names the product by id or by a scanned barcode / typed SKU. "add"
 * adds to what is already counted (a scan is add 1); "set" replaces it.
 */
export const recordCountsSchema = z.object({
  entries: z
    .array(
      z
        .object({
          variantId: z.uuid().optional(),
          code: z.string().trim().min(1).max(64).optional(),
          quantity: z
            .number()
            .min(-1_000_000_000)
            .max(1_000_000_000)
            .refine(threeDecimals, 'Use at most 3 decimals')
            .default(1),
          mode: z.enum(['add', 'set']).default('add'),
        })
        .refine((entry) => (entry.variantId === undefined) !== (entry.code === undefined), {
          message: 'Give either a product id or a barcode/SKU',
        })
        .refine((entry) => entry.mode === 'add' || entry.quantity >= 0, {
          path: ['quantity'],
          message: 'A counted quantity cannot be negative',
        }),
    )
    .min(1)
    .max(500),
});
export type RecordCountsInput = z.output<typeof recordCountsSchema>;

export const submitCountSchema = z.object({
  /** Treat products nobody counted as none on the shelf. */
  uncountedAsZero: z.boolean().default(false),
});

export const approveCountSchema = z.object({
  reasons: z
    .array(z.object({ variantId: z.uuid(), reason: z.enum(VARIANCE_REASONS) }))
    .max(500)
    .default([]),
});
export type ApproveCountInput = z.output<typeof approveCountSchema>;

export const cancelCountSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const listCountsSchema = z.object({
  storeId: z.uuid().optional(),
  status: z.enum(COUNT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListCountsQuery = z.output<typeof listCountsSchema>;
