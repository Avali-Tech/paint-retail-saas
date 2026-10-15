import { z } from 'zod';

/** Up to ₹10 crore, as party limits. */
const limit = z.number().int().min(1).max(10_000_000_000);
const notes = z.string().trim().min(1).max(4000);

export const createSiteSchema = z.object({
  projectId: z.uuid(),
  limitPaise: limit,
  notes: notes.optional(),
});
export type CreateSiteInput = z.output<typeof createSiteSchema>;

export const updateSiteSchema = z
  .object({ limitPaise: limit.optional(), notes: notes.nullable().optional() })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type UpdateSiteInput = z.output<typeof updateSiteSchema>;

export const siteHoldSchema = z.object({ reason: z.string().trim().min(3).max(500) });
