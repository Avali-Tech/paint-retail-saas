import { isValidGstin } from '@paint/shared';
import { z } from 'zod';
import { storeGstSchema } from '../tax/tax.schemas.js';

const name = z.string().trim().min(2).max(120);
const type = z.enum(['store', 'godown']);

export const createStoreSchema = z
  .object({
    name,
    /** Short code printed on documents, e.g. "HYD1". Stored uppercase. */
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{2,12}$/, 'Use 2 to 12 letters, digits or dashes'),
    type: type.default('store'),
    city: z.string().trim().min(1).max(80).optional(),
    state: z.string().trim().min(1).max(80).optional(),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .refine(isValidGstin, 'Enter a valid GSTIN (check for typos)')
      .optional(),
    /**
     * The store's GST registration, state and address, saved with it in one go
     * (as PUT /gst-registrations/stores/:id does; needs tax:manage too).
     */
    registration: storeGstSchema.optional(),
  })
  .refine(
    (body) =>
      body.registration === undefined ||
      (body.city === undefined && body.state === undefined && body.gstin === undefined),
    {
      path: ['registration'],
      message: 'Give the city, state and GSTIN in the registration',
    },
  );
export type CreateStoreInput = z.output<typeof createStoreSchema>;

/** PATCH /stores/:id: what may change once a store exists; its code stays (documents use it). */
export const updateStoreSchema = z
  .object({
    name: name.optional(),
    type: type.optional(),
    /** False closes the store: it leaves pickers, its history stays. */
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type UpdateStoreInput = z.output<typeof updateStoreSchema>;
