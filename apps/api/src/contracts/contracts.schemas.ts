import { schema } from '@paint/db';
import { z } from 'zod';

export const CONTRACT_TYPES = schema.contractType.enumValues;
/** Statuses as shown: the stored ones plus "expired" (active, past its end date in India). */
export const CONTRACT_STATUSES = [...schema.contractStatus.enumValues, 'expired'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

const text = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.iso.date();
const paise = z.number().int().min(0).max(100_000_000_000_00);

const datesInOrder = {
  check: (body: { startDate?: string | null; endDate?: string | null }) =>
    !body.startDate || !body.endDate || body.endDate >= body.startDate,
  issue: { path: ['endDate'], message: 'The end date cannot be before the start date' },
};
const renewalByEnd = {
  check: (body: { renewalDate?: string | null; endDate?: string | null }) =>
    !body.renewalDate || !body.endDate || body.renewalDate <= body.endDate,
  issue: { path: ['renewalDate'], message: 'The renewal date cannot be after the end date' },
};

export const createContractSchema = z
  .object({
    type: z.enum(CONTRACT_TYPES),
    title: text(160),
    partyId: z.uuid(),
    /** Leave out for a business-wide agreement; taken from the project when one is given. */
    storeId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    startDate: isoDate,
    endDate: isoDate,
    /** Defaults to 30 days before the end (or the start, for short contracts). */
    renewalDate: isoDate.optional(),
    valuePaise: paise.optional(),
    terms: text(8000).optional(),
    creditTerms: text(2000).optional(),
    discountTerms: text(2000).optional(),
    notes: text(4000).optional(),
    /** Defaults to whoever creates it. */
    assignedMemberId: z.uuid().optional(),
  })
  .refine(datesInOrder.check, datesInOrder.issue)
  .refine(renewalByEnd.check, renewalByEnd.issue);
export type CreateContractInput = z.output<typeof createContractSchema>;

export const updateContractSchema = z
  .object({
    type: z.enum(CONTRACT_TYPES).optional(),
    title: text(160).optional(),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    /** Moving the start or end without this resets it to the default. */
    renewalDate: isoDate.optional(),
    valuePaise: paise.nullable().optional(),
    terms: text(8000).nullable().optional(),
    creditTerms: text(2000).nullable().optional(),
    discountTerms: text(2000).nullable().optional(),
    notes: text(4000).nullable().optional(),
    assignedMemberId: z.uuid().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' })
  .refine(datesInOrder.check, datesInOrder.issue)
  .refine(renewalByEnd.check, renewalByEnd.issue);
export type UpdateContractInput = z.output<typeof updateContractSchema>;

/** The follow-on contract; anything left out is copied from the one being renewed. */
export const renewContractSchema = z
  .object({
    /** Defaults to the day after the current contract ends. */
    startDate: isoDate.optional(),
    endDate: isoDate,
    renewalDate: isoDate.optional(),
    title: text(160).optional(),
    valuePaise: paise.nullable().optional(),
    terms: text(8000).nullable().optional(),
    creditTerms: text(2000).nullable().optional(),
    discountTerms: text(2000).nullable().optional(),
    notes: text(4000).nullable().optional(),
  })
  .refine(datesInOrder.check, datesInOrder.issue)
  .refine(renewalByEnd.check, renewalByEnd.issue);
export type RenewContractInput = z.output<typeof renewContractSchema>;

export const listContractsSchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(CONTRACT_STATUSES).optional(),
  type: z.enum(CONTRACT_TYPES).optional(),
  partyId: z.uuid().optional(),
  storeId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  /**
   * Active contracts ending within this many days, including those already
   * past their end and not yet renewed; soonest first.
   */
  renewalDue: z.coerce.number().int().min(0).max(366).optional(),
  assignedTo: z.union([z.uuid(), z.literal('me')]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListContractsQuery = z.output<typeof listContractsSchema>;
