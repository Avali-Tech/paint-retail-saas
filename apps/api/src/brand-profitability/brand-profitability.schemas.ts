import {
  DEFAULT_COST_OF_MONEY_BPS,
  DEFAULT_POINT_VALUE_PAISE,
  PROFITABILITY_GROUPS,
  PROFITABILITY_MAX_DAYS,
  daysBetween,
} from '@paint/shared';
import { z } from 'zod';

const isoDate = z.iso.date('Use a date like 2026-04-01');

/**
 * GET /reports/brand-profitability (and its CSV). The period is both days or
 * neither (the last quarter). The cost of money is the business's ([PO-5]):
 * there is no setting for it yet ([PO-83]), so it is 12 % unless the request
 * says otherwise.
 */
export const brandProfitabilitySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    storeId: z.uuid().optional(),
    brandId: z.uuid().optional(),
    productId: z.uuid().optional(),
    groupBy: z.enum(PROFITABILITY_GROUPS).default('brand'),
    costOfMoneyBps: z.coerce.number().int().min(0).max(10_000).default(DEFAULT_COST_OF_MONEY_BPS),
    pointValuePaise: z.coerce.number().int().min(0).max(100_000).default(DEFAULT_POINT_VALUE_PAISE),
  })
  .refine((query) => (query.from === undefined) === (query.to === undefined), {
    path: ['to'],
    message: 'Give both the first and the last day, or neither',
  })
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
    path: ['to'],
    message: 'The last day cannot be before the first',
  })
  .refine(
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      daysBetween(query.from, query.to) < PROFITABILITY_MAX_DAYS,
    { path: ['to'], message: `Pick at most ${String(PROFITABILITY_MAX_DAYS)} days` },
  );
export type BrandProfitabilityInput = z.output<typeof brandProfitabilitySchema>;
