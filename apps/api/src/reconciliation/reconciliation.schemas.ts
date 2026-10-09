import { z } from 'zod';

export const listRunsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListRunsQuery = z.output<typeof listRunsSchema>;
