import { z } from 'zod';

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

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
    .regex(GSTIN, 'Enter a valid 15-character GSTIN')
    .optional(),
});
export type CreateStoreInput = z.output<typeof createStoreSchema>;
