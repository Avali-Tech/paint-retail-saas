import { isValidGstin } from '@paint/shared';
import { z } from 'zod';

export const createStoreSchema = z.object({
  name: z.string().trim().min(2).max(120),
  /** Short code printed on documents, e.g. "HYD1". Stored uppercase. */
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,12}$/, 'Use 2 to 12 letters, digits or dashes'),
  type: z.enum(['store', 'godown']).default('store'),
  city: z.string().trim().min(1).max(80).optional(),
  state: z.string().trim().min(1).max(80).optional(),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .refine(isValidGstin, 'Enter a valid GSTIN (check for typos)')
    .optional(),
});
export type CreateStoreInput = z.output<typeof createStoreSchema>;
