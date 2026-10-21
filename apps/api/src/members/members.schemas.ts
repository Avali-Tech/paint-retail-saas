import { PERMISSIONS } from '@paint/shared';
import { z } from 'zod';
import { ACTIVITY_RECORD_TYPES } from '../activities/activities.schemas.js';
import { email, password, phone } from '../auth/auth.schemas.js';

/** Store ids, de-duplicated. */
const storeIds = z
  .array(z.uuid())
  .max(500)
  .transform((ids) => [...new Set(ids)]);

/** Permission keys, de-duplicated. */
const permissionList = z
  .array(z.enum(PERMISSIONS))
  .max(PERMISSIONS.length)
  .transform((keys) => [...new Set(keys)].sort());

/** A member's own exceptions to their role. */
const exceptions = z
  .object({ granted: permissionList.default([]), denied: permissionList.default([]) })
  .refine((body) => !body.granted.some((permission) => body.denied.includes(permission)), {
    path: ['denied'],
    message: 'A permission cannot be both granted and denied',
  });

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
    exceptions: exceptions.default({ granted: [], denied: [] }),
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
    /** Replaces the member's exceptions. */
    exceptions: exceptions.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.roleId !== undefined ||
      body.allStores !== undefined ||
      body.storeIds !== undefined ||
      body.exceptions !== undefined ||
      body.isActive !== undefined,
    { message: 'Nothing to change' },
  );
export type UpdateMemberInput = z.output<typeof updateMemberSchema>;

/** Who a new or existing record can be handed to: what for, and at which store. */
export const assignableSchema = z.discriminatedUnion('for', [
  z.object({
    for: z.enum(['lead', 'opportunity', 'project', 'contract']),
    /** The record's store; left out for business-wide records. */
    storeId: z.uuid().optional(),
  }),
  z.object({
    /** A follow-up or other activity on a record of this type. */
    for: z.literal('activity'),
    recordType: z.enum(ACTIVITY_RECORD_TYPES),
    storeId: z.uuid().optional(),
  }),
]);
export type AssignableQuery = z.output<typeof assignableSchema>;
