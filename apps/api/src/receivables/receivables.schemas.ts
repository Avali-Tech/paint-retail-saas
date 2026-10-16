import { AGEING_GROUPS, type ReceivablesQuery } from '@paint/shared';
import { z } from 'zod';

const isoDate = z.iso.date('Use a date like 2026-04-01');

/** A member's id, or "none" for customers nobody looks after. */
const salesperson = z.union([z.uuid(), z.literal('none')]);

const filters = {
  asOf: isoDate.optional(),
  storeId: z.uuid().optional(),
  salespersonId: salesperson.optional(),
};

export const receivablesQuerySchema = z.object(filters) satisfies z.ZodType<ReceivablesQuery>;
export type ReceivablesQueryInput = z.output<typeof receivablesQuerySchema>;

export const ageingQuerySchema = z.object({
  ...filters,
  groupBy: z.enum(AGEING_GROUPS).default('customer'),
  q: z.string().trim().min(1).max(100).optional(),
  projectId: z.uuid().optional(),
  overdueOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AgeingQueryInput = z.output<typeof ageingQuerySchema>;
