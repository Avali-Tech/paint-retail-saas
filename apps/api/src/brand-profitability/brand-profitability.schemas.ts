import { PROFITABILITY_GROUPS, PROFITABILITY_MAX_DAYS, daysBetween } from '@paint/shared';
import { z } from 'zod';

const isoDate = z.iso.date('Use a date like 2026-04-01');
const costOfMoney = z.coerce.number().int().min(0).max(10_000);
const pointValue = z.coerce.number().int().min(0).max(100_000);

/**
 * GET /reports/brand-profitability (and its CSV). The period is both days or
 * neither (the last quarter). The cost of money ([PO-5], [PO-83]) and the point
 * value ([PO-81]) are the business's settings unless the request overrides them.
 */
export const brandProfitabilitySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    storeId: z.uuid().optional(),
    brandId: z.uuid().optional(),
    productId: z.uuid().optional(),
    groupBy: z.enum(PROFITABILITY_GROUPS).default('brand'),
    costOfMoneyBps: costOfMoney.optional(),
    pointValuePaise: pointValue.optional(),
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

/** PUT /reports/brand-profitability/settings: either or both, in basis points and paise. */
export const profitabilitySettingsSchema = z
  .object({
    costOfMoneyBps: z.number().int().min(0).max(10_000).optional(),
    pointValuePaise: z.number().int().min(0).max(100_000).optional(),
  })
  .refine(
    (body) => body.costOfMoneyBps !== undefined || body.pointValuePaise !== undefined,
    'Nothing to change',
  );
