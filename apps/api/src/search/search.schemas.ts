import { z } from 'zod';

export const searchSchema = z.object({
  q: z.string().trim().min(2, 'Type at least 2 characters').max(100),
  /** Results per group. */
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
export type SearchQuery = z.output<typeof searchSchema>;

export const actionsSchema = z.object({ q: z.string().trim().max(100).default('') });
