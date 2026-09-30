import { z } from 'zod';
import { email, password, phone } from '../auth/auth.schemas.js';

/** Store ids, de-duplicated. */
const storeIds = z
  .array(z.uuid())
  .max(500)
  .transform((ids) => [...new Set(ids)]);

export const createMemberSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120),
    phone: phone.optional(),
    email: email.optional(),
    /** Optional: without one, the person signs in with an SMS code. */
    password: password.optional(),
    roleId: z.uuid(),
    allStores: z.boolean().default(false),
    storeIds: storeIds.default([]),
  })
  .refine((body) => body.phone !== undefined || body.email !== undefined, {
    path: ['phone'],
    message: 'Enter a mobile number or an email address',
  });
export type CreateMemberInput = z.output<typeof createMemberSchema>;

export const updateMemberSchema = z
  .object({
    roleId: z.uuid().optional(),
    allStores: z.boolean().optional(),
    /** Replaces the member's stores. */
    storeIds: storeIds.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.roleId !== undefined ||
      body.allStores !== undefined ||
      body.storeIds !== undefined ||
      body.isActive !== undefined,
    { message: 'Nothing to change' },
  );
export type UpdateMemberInput = z.output<typeof updateMemberSchema>;
