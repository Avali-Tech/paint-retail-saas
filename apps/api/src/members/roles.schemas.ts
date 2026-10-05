import { PERMISSIONS } from '@paint/shared';
import { z } from 'zod';

const name = z.string().trim().min(2).max(60);
/** Permission keys, de-duplicated and sorted. */
const permissions = z
  .array(z.enum(PERMISSIONS))
  .min(1)
  .max(PERMISSIONS.length * 2)
  .transform((keys) => [...new Set(keys)].sort());

export const createRoleSchema = z.object({ name, permissions });
export type CreateRoleInput = z.output<typeof createRoleSchema>;

export const updateRoleSchema = z
  .object({ name: name.optional(), permissions: permissions.optional() })
  .refine((body) => body.name !== undefined || body.permissions !== undefined, {
    message: 'Nothing to change',
  });
export type UpdateRoleInput = z.output<typeof updateRoleSchema>;
