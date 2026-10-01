import { schema } from '@paint/db';
import { z } from 'zod';
import { pincode } from '../parties/parties.schemas.js';

export const PROJECT_STAGES = schema.projectStage.enumValues;
export const PROJECT_PARTY_ROLES = schema.projectPartyRole.enumValues;
/** Stages a project can be moved to by hand; cancelling has its own action. */
export const WORK_STAGES = [
  'identified',
  'survey',
  'specification',
  'quotation',
  'negotiation',
  'order',
  'execution',
  'completed',
] as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.iso.date();
const decimals = (places: number) => (value: number) =>
  Math.abs(Math.round(value * 10 ** places) - value * 10 ** places) < 1e-6;
const area = z.number().positive().max(100_000_000).refine(decimals(2), 'Use at most 2 decimals');
const litres = z.number().positive().max(100_000_000).refine(decimals(3), 'Use at most 3 decimals');
const paise = z.number().int().min(0).max(100_000_000_000_00);
const latitude = z.number().min(-90).max(90).refine(decimals(6), 'Use at most 6 decimals');
const longitude = z.number().min(-180).max(180).refine(decimals(6), 'Use at most 6 decimals');

const partyLinks = z
  .array(z.object({ partyId: z.uuid(), role: z.enum(PROJECT_PARTY_ROLES) }))
  .max(50)
  .refine(
    (links) => new Set(links.map((link) => `${link.partyId}:${link.role}`)).size === links.length,
    'Each person can appear once per role',
  );

const pinComplete = {
  check: (body: { latitude?: number | null; longitude?: number | null }) =>
    (body.latitude === undefined) === (body.longitude === undefined) &&
    (body.latitude === null) === (body.longitude === null),
  issue: { path: ['latitude'], message: 'Give both latitude and longitude for the map pin' },
};

/** Site and job details shared by creating a project and converting an opportunity. */
const details = {
  addressLine: text(300).optional(),
  city: text(80).optional(),
  state: text(80).optional(),
  pincode: pincode.optional(),
  latitude: latitude.optional(),
  longitude: longitude.optional(),
  startDate: isoDate.optional(),
  expectedCompletionDate: isoDate.optional(),
  estimatedAreaSqFt: area.optional(),
  estimatedPaintLitres: litres.optional(),
  expectedOrderValuePaise: paise.optional(),
  notes: text(4000).optional(),
  /** Defaults to whoever creates it (or the opportunity's salesperson). */
  assignedMemberId: z.uuid().optional(),
  parties: partyLinks.default([]),
};

export const createProjectSchema = z
  .object({ storeId: z.uuid(), customerPartyId: z.uuid(), name: text(160), ...details })
  .refine(pinComplete.check, pinComplete.issue);
export type CreateProjectInput = z.output<typeof createProjectSchema>;

export const fromOpportunitySchema = z
  .object({ name: text(160).optional(), ...details })
  .refine(pinComplete.check, pinComplete.issue);
export type FromOpportunityInput = z.output<typeof fromOpportunitySchema>;

export const updateProjectSchema = z
  .object({
    name: text(160).optional(),
    addressLine: text(300).nullable().optional(),
    city: text(80).nullable().optional(),
    state: text(80).nullable().optional(),
    pincode: pincode.nullable().optional(),
    latitude: latitude.nullable().optional(),
    longitude: longitude.nullable().optional(),
    startDate: isoDate.nullable().optional(),
    expectedCompletionDate: isoDate.nullable().optional(),
    estimatedAreaSqFt: area.nullable().optional(),
    estimatedPaintLitres: litres.nullable().optional(),
    expectedOrderValuePaise: paise.nullable().optional(),
    notes: text(4000).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' })
  .refine(pinComplete.check, pinComplete.issue);
export type UpdateProjectInput = z.output<typeof updateProjectSchema>;

export const projectStageSchema = z.object({ stage: z.enum(WORK_STAGES) });
export const partiesSchema = z.object({ parties: partyLinks });
export type ProjectPartyLink = z.output<typeof partyLinks>[number];

export const listProjectsSchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  storeId: z.uuid().optional(),
  stage: z.enum(PROJECT_STAGES).optional(),
  /** Projects where this party is the customer or linked in any role. */
  partyId: z.uuid().optional(),
  assignedTo: z.union([z.uuid(), z.literal('me')]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListProjectsQuery = z.output<typeof listProjectsSchema>;

export const projectPipelineSchema = z.object({
  storeId: z.uuid().optional(),
  assignedTo: z.union([z.uuid(), z.literal('me')]).optional(),
});
export type ProjectPipelineQuery = z.output<typeof projectPipelineSchema>;
