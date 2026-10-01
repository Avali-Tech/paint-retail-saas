import { schema } from '@paint/db';
import { z } from 'zod';
import { phone } from '../auth/auth.schemas.js';

export const LEAD_SOURCES = schema.leadSource.enumValues;
export const LEAD_STAGES = schema.leadStage.enumValues;
export const OPPORTUNITY_STAGES = schema.opportunityStage.enumValues;

/** Stages a lead can be moved between by hand; the rest come from converting, winning or losing. */
export const OPEN_LEAD_STAGES = ['new', 'contacted', 'qualified'] as const;
export const OPEN_OPPORTUNITY_STAGES = ['discovery', 'proposal', 'negotiation'] as const;

const title = z.string().trim().min(3).max(160);
const longText = z.string().trim().min(1).max(2000);
const paise = z.number().int().min(0).max(100_000_000_000_00);
const isoDate = z.iso.date();
const reason = z.object({ reason: z.string().trim().min(3).max(500) });
const probability = z.number().int().min(0).max(100);
const quantity = z
  .number()
  .positive()
  .max(100_000_000)
  .refine(
    (value) => Math.abs(Math.round(value * 1000) - value * 1000) < 1e-6,
    'Use at most 3 decimals',
  );
const page = {
  q: z.string().trim().min(1).max(100).optional(),
  storeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};
/** A member id, or "me". */
const assignee = z.union([z.uuid(), z.literal('me')]).optional();

export const createLeadSchema = z
  .object({
    storeId: z.uuid(),
    /** An existing party… */
    partyId: z.uuid().optional(),
    /** …or a quick contact: matched by mobile number, else added as a customer. */
    contact: z
      .object({
        displayName: z.string().trim().min(2).max(160),
        phone,
        kind: z.enum(['person', 'organization']).default('person'),
      })
      .optional(),
    title,
    requirement: longText.optional(),
    source: z.enum(LEAD_SOURCES),
    referredByPartyId: z.uuid().optional(),
    estimatedValuePaise: paise.optional(),
    expectedOrderDate: isoDate.optional(),
    /** Defaults to whoever creates the lead. */
    assignedMemberId: z.uuid().optional(),
  })
  .refine((body) => (body.partyId === undefined) !== (body.contact === undefined), {
    path: ['partyId'],
    message: 'Give either partyId or contact',
  });
export type CreateLeadInput = z.output<typeof createLeadSchema>;

export const updateLeadSchema = z
  .object({
    title: title.optional(),
    requirement: longText.nullable().optional(),
    source: z.enum(LEAD_SOURCES).optional(),
    referredByPartyId: z.uuid().nullable().optional(),
    estimatedValuePaise: paise.nullable().optional(),
    expectedOrderDate: isoDate.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type UpdateLeadInput = z.output<typeof updateLeadSchema>;

export const listLeadsSchema = z.object({
  ...page,
  stage: z.enum(LEAD_STAGES).optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  assignedTo: assignee,
});
export type ListLeadsQuery = z.output<typeof listLeadsSchema>;

export const pipelineSchema = z.object({ storeId: z.uuid().optional(), assignedTo: assignee });
export type PipelineQuery = z.output<typeof pipelineSchema>;

export const assignSchema = z.object({ memberId: z.uuid() });
export const leadStageSchema = z.object({ stage: z.enum(OPEN_LEAD_STAGES) });
export const reasonSchema = reason;

const opportunityFields = {
  expectedValuePaise: paise,
  expectedQuantity: quantity.optional(),
  expectedOrderDate: isoDate.optional(),
  categoryId: z.uuid().optional(),
  probability: probability.optional(),
  /** Defaults to the lead's assignee, else whoever creates it. */
  salespersonMemberId: z.uuid().optional(),
};

export const convertLeadSchema = z.object({ title: title.optional(), ...opportunityFields });
export type ConvertLeadInput = z.output<typeof convertLeadSchema>;

export const createOpportunitySchema = z.object({
  storeId: z.uuid(),
  partyId: z.uuid(),
  title,
  ...opportunityFields,
});
export type CreateOpportunityInput = z.output<typeof createOpportunitySchema>;

export const updateOpportunitySchema = z
  .object({
    title: title.optional(),
    expectedValuePaise: paise.optional(),
    expectedQuantity: quantity.nullable().optional(),
    expectedOrderDate: isoDate.nullable().optional(),
    categoryId: z.uuid().nullable().optional(),
    probability: probability.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type UpdateOpportunityInput = z.output<typeof updateOpportunitySchema>;

export const opportunityStageSchema = z.object({
  stage: z.enum(OPEN_OPPORTUNITY_STAGES),
  /** Defaults to the stage's usual chance. */
  probability: probability.optional(),
});
export type OpportunityStageInput = z.output<typeof opportunityStageSchema>;

export const listOpportunitiesSchema = z.object({
  ...page,
  stage: z.enum(OPPORTUNITY_STAGES).optional(),
  assignedTo: assignee,
});
export type ListOpportunitiesQuery = z.output<typeof listOpportunitiesSchema>;
