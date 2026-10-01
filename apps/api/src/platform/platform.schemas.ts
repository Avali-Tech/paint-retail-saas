import { FEATURE_FLAG_KEYS, PLAN_KEYS } from '@paint/shared';
import { z } from 'zod';
import { email, password, phone } from '../auth/auth.schemas.js';

export const bootstrapSchema = z
  .object({
    token: z.string().min(1),
    fullName: z.string().trim().min(2).max(120),
    email: email.optional(),
    phone: phone.optional(),
    password,
  })
  .refine((body) => body.email !== undefined || body.phone !== undefined, {
    path: ['email'],
    message: 'Enter an email address or a mobile number',
  });
export type BootstrapInput = z.output<typeof bootstrapSchema>;

export const platformLoginSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(200),
});
export type PlatformLoginInput = z.output<typeof platformLoginSchema>;

export const createTenantSchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  plan: z.enum(PLAN_KEYS).default('trial'),
  /** The owner signs in with a one-time code sent to this number. */
  owner: z.object({
    fullName: z.string().trim().min(2).max(120),
    phone,
    email: email.optional(),
  }),
});
export type CreateTenantInput = z.output<typeof createTenantSchema>;

export const updateTenantSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    plan: z.enum(PLAN_KEYS).optional(),
    /** true or false to override the plan; null to go back to the plan's default. */
    featureFlags: z.partialRecord(z.enum(FEATURE_FLAG_KEYS), z.boolean().nullable()).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type UpdateTenantInput = z.output<typeof updateTenantSchema>;

export const listTenantsSchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListTenantsQuery = z.output<typeof listTenantsSchema>;

export const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });
