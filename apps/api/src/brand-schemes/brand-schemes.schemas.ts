import {
  BENEFIT_MONEY_FORMS,
  BRAND_CLAIM_STATUSES,
  DEFAULT_PLANNER_RATES,
  SCHEME_DATE_BASES,
  SCHEME_STATUSES,
  SLAB_MEASURES,
  SLAB_MODES,
} from '@paint/shared';
import { z } from 'zod';

const isoDate = z.iso.date('Use a date like 2026-04-01');
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().default(null);
const ids = z.array(z.uuid()).max(200).default([]);

/** A slab benefit (the engine's `SlabBenefit`). */
const benefitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rebate'), basisPoints: z.number().int().min(1).max(10_000) }),
  z.object({
    kind: z.literal('per_litre'),
    paisePerLitre: z.number().int().min(1).max(1_00_00_000),
  }),
  z.object({
    kind: z.literal('free_goods'),
    variantId: z.uuid(),
    units: z.number().int().min(1).max(1_000_000),
    /** Units for every whole this many millilitres; null for once on reaching the slab. */
    perMillilitres: z.number().int().min(1).max(1_000_000_000).nullable().default(null),
  }),
  z.object({
    kind: z.literal('points'),
    label: z.string().trim().min(1).max(60),
    points: z.number().int().min(1).max(100_000_000),
  }),
]);

/** POST /brand-schemes and PUT /brand-schemes/:id: the whole scheme. */
export const schemeSchema = z
  .object({
    brandId: z.uuid(),
    name: z.string().trim().min(1).max(120),
    brandReference: optionalText(60),
    startsOn: isoDate,
    endsOn: isoDate,
    measure: z.enum(SLAB_MEASURES),
    mode: z.enum(SLAB_MODES).default('retro'),
    settlementDays: z.number().int().min(0).max(365).nullable().default(null),
    dateBasis: z.enum(SCHEME_DATE_BASES).default('grn_date'),
    note: optionalText(500),
    productIds: ids,
    categoryIds: ids,
    slabs: z
      .array(
        z.object({
          target: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
          benefits: z.array(benefitSchema).min(1).max(10),
        }),
      )
      .min(1)
      .max(20),
  })
  .superRefine((body, context) => {
    if (body.endsOn < body.startsOn) {
      context.addIssue({ code: 'custom', path: ['endsOn'], message: 'Ends before it starts' });
    }
  });
export type SchemeBody = z.output<typeof schemeSchema>;

/** Closing or cancelling a scheme. */
export const endSchemeSchema = z.object({ note: optionalText(500) });
export type EndSchemeBody = z.output<typeof endSchemeSchema>;

const receiptBase = {
  receivedOn: isoDate,
  reference: optionalText(60),
  note: optionalText(500),
  claimId: z.uuid().nullable().default(null),
};

/** POST /brand-schemes/:id/receipts: what the brand issued. Negative reverses an entry. */
export const receiptSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('money'),
    amountPaise: z
      .number()
      .int()
      .min(-1_00_00_00_000)
      .max(1_00_00_00_000)
      .refine((amount) => amount !== 0, 'Enter an amount'),
    moneyForm: z.enum(BENEFIT_MONEY_FORMS),
    ...receiptBase,
  }),
  z.object({
    kind: z.literal('free_goods'),
    variantId: z.uuid(),
    units: z
      .number()
      .int()
      .min(-1_000_000)
      .max(1_000_000)
      .refine((units) => units !== 0, 'Enter the units'),
    goodsReceiptId: z.uuid().nullable().default(null),
    ...receiptBase,
  }),
  z.object({
    kind: z.literal('points'),
    label: z.string().trim().min(1).max(60),
    points: z
      .number()
      .int()
      .min(-100_000_000)
      .max(100_000_000)
      .refine((points) => points !== 0, 'Enter the points'),
    ...receiptBase,
  }),
]);
export type ReceiptBody = z.output<typeof receiptSchema>;

/** POST /brand-schemes/:id/claims: a claim filed with the brand. */
export const claimSchema = z.object({
  filedOn: isoDate,
  /** Left out: the money the scheme still has owed on the day filed. */
  claimedPaise: z.number().int().min(0).max(1_00_00_00_000).optional(),
  brandReference: optionalText(60),
  note: optionalText(500),
});
export type ClaimBody = z.output<typeof claimSchema>;

/** POST /brand-schemes/claims/:id/status: following a claim up. */
export const claimStatusSchema = z.object({
  status: z.enum(BRAND_CLAIM_STATUSES).exclude(['filed']),
  brandReference: optionalText(60),
  note: optionalText(500),
});
export type ClaimStatusBody = z.output<typeof claimStatusSchema>;

/** GET /brand-schemes. */
export const listSchemesSchema = z.object({
  status: z.enum(SCHEME_STATUSES).optional(),
  brandId: z.uuid().optional(),
  asOf: isoDate.optional(),
});
export type ListSchemesQuery = z.output<typeof listSchemesSchema>;

/** GET /brand-schemes/:id, /overview and /claims. */
export const asOfSchema = z.object({ asOf: isoDate.optional(), brandId: z.uuid().optional() });
export type AsOfQuery = z.output<typeof asOfSchema>;

const bps = (fallback: number) => z.number().int().min(0).max(10_000).default(fallback);

/** POST /brand-schemes/price-hike-plan. */
export const priceHikeSchema = z.object({
  brandId: z.uuid(),
  hikeBasisPoints: z.number().int().min(1).max(5_000),
  effectiveOn: isoDate,
  productIds: ids,
  categoryIds: ids,
  storeId: z.uuid().nullable().default(null),
  salesWindowDays: z.number().int().min(7).max(365).default(90),
  holdingCostBps: bps(DEFAULT_PLANNER_RATES.holdingCostBps),
  costOfMoneyBps: bps(DEFAULT_PLANNER_RATES.costOfMoneyBps),
  deadStockRiskBps: bps(DEFAULT_PLANNER_RATES.deadStockRiskBps),
  maxCoverDays: z.number().int().min(1).max(365).default(DEFAULT_PLANNER_RATES.maxCoverDays),
});
export type PriceHikeBody = z.output<typeof priceHikeSchema>;
