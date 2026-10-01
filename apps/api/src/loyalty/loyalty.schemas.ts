import { schema } from '@paint/db';
import { z } from 'zod';

export const LOYALTY_STATUSES = schema.loyaltyStatus.enumValues;

const text = (max: number) => z.string().trim().min(1).max(max);
/** Points in one entry: up to ten million. */
const points = z.number().int().min(1).max(10_000_000);

export const loyaltySettingsSchema = z.object({
  earnPoints: z.number().int().min(1).max(1_000),
  /** Paise of purchases per `earnPoints`, e.g. 10,000 = ₹100. */
  earnPerPaise: z.number().int().min(100).max(10_000_000),
  tiers: z
    .array(z.object({ name: text(40), minPoints: z.number().int().min(0).max(100_000_000) }))
    .max(10)
    .refine(
      (tiers) => new Set(tiers.map((tier) => tier.name.toLowerCase())).size === tiers.length,
      'Each tier needs its own name',
    )
    .refine(
      (tiers) => new Set(tiers.map((tier) => tier.minPoints)).size === tiers.length,
      'Each tier needs its own points threshold',
    ),
  /** Null: points never expire. */
  expiryDays: z.number().int().min(1).max(3650).nullable(),
  minRedemptionPoints: z.number().int().min(0).max(10_000_000),
});
export type LoyaltySettingsInput = z.output<typeof loyaltySettingsSchema>;

export const enrolSchema = z.object({ assignedMemberId: z.uuid().optional() });

export const updateAccountSchema = z
  .object({
    status: z.enum(LOYALTY_STATUSES).optional(),
    assignedMemberId: z.uuid().nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type UpdateAccountInput = z.output<typeof updateAccountSchema>;

/** A purchase entered by hand until billing exists (Release 2.0). */
export const purchaseSchema = z.object({
  manualPurchasePaise: z.number().int().min(1).max(100_000_000_000_00),
  /** The bill or invoice number. */
  reference: text(80),
  note: text(500).optional(),
});
export type PurchaseInput = z.output<typeof purchaseSchema>;

export const awardSchema = z.object({
  points,
  /** Name of the campaign, for a campaign award; leave out for a manual award. */
  campaign: text(80).optional(),
  note: text(500).optional(),
});
export type AwardInput = z.output<typeof awardSchema>;

export const redeemSchema = z.object({ points, note: text(500).optional() });
export type RedeemInput = z.output<typeof redeemSchema>;

export const adjustSchema = z.object({
  points: z
    .number()
    .int()
    .min(-10_000_000)
    .max(10_000_000)
    .refine((value) => value !== 0, 'An adjustment must add or take away points'),
  reason: text(500),
});
export type AdjustInput = z.output<typeof adjustSchema>;

export const ledgerPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listAccountsSchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(LOYALTY_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListAccountsQuery = z.output<typeof listAccountsSchema>;
