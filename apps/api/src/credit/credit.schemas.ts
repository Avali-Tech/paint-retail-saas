import { schema } from '@paint/db';
import { z } from 'zod';
import { MAX_CREDIT_DAYS, MAX_CREDIT_LIMIT_PAISE } from './credit-terms.js';

export const CREDIT_STATUSES = schema.creditStatus.enumValues;
export const CREDIT_RISKS = schema.creditRisk.enumValues;
export const CREDIT_REQUEST_STATUSES = schema.creditRequestStatus.enumValues;

const text = (max: number) => z.string().trim().min(1).max(max);
/** Up to ₹10 crore of credit; exposures may exceed it. */
const limit = z.number().int().min(1).max(MAX_CREDIT_LIMIT_PAISE);
const paise = z.number().int().min(0).max(100_000_000_000_00);
const days = z.number().int().min(0).max(MAX_CREDIT_DAYS);

export const creditRequestSchema = z.object({
  partyId: z.uuid(),
  limitPaise: limit,
  creditDays: days,
  /** Why the party should get it, for the approver. */
  note: text(1000).optional(),
});
export type CreditRequestInput = z.output<typeof creditRequestSchema>;

export const decisionSchema = z.object({ note: text(1000).optional() });
export const rejectionSchema = z.object({ reason: text(1000) });

export const updateCreditSchema = z
  .object({
    risk: z.enum(CREDIT_RISKS).optional(),
    /** What the party owes now, entered by hand until billing exists (Release 2.0). */
    manualExposurePaise: paise.optional(),
    overdueDays: z.number().int().min(0).max(10_000).optional(),
    notes: text(4000).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type UpdateCreditInput = z.output<typeof updateCreditSchema>;

export const holdSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const creditCheckSchema = z.object({
  /** The sale to check; leave out to see where the party stands now. */
  amountPaise: z.coerce.number().int().min(-100_000_000_000_00).max(100_000_000_000_00).default(0),
});

export const creditRulesSchema = z
  .object({
    normalUpToPercent: z.number().int().min(0).max(1000),
    managerUpToPercent: z.number().int().min(0).max(1000),
    holdAfterOverdueDays: z.number().int().min(1).max(3650),
  })
  .refine((rules) => rules.normalUpToPercent <= rules.managerUpToPercent, {
    path: ['managerUpToPercent'],
    message: 'Manager approval must start at or above the normal limit',
  });

export const listCreditSchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  /** Defaults to parties with credit (active or on hold). */
  status: z.enum(CREDIT_STATUSES).optional(),
  risk: z.enum(CREDIT_RISKS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListCreditQuery = z.output<typeof listCreditSchema>;

export const listRequestsSchema = z.object({
  status: z.enum(CREDIT_REQUEST_STATUSES).optional(),
  partyId: z.uuid().optional(),
  /** Only those of customers at one store (their home store). */
  storeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListRequestsQuery = z.output<typeof listRequestsSchema>;
