import { schema } from '@paint/db';
import { isValidGstin, isValidPan, isValidPincode } from '@paint/shared';
import { z } from 'zod';
import { email, phone } from '../auth/auth.schemas.js';

export const PARTY_ROLES = schema.partyRole.enumValues;
export const CUSTOMER_TYPES = schema.customerType.enumValues;
export const CONTACT_METHODS = schema.contactMethod.enumValues;

const unique = <T>(values: T[]) => [...new Set(values)];
const text = (max: number) => z.string().trim().min(1).max(max);
const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isValidGstin, 'Enter a valid GSTIN (check for typos)');
const pan = z.string().trim().toUpperCase().refine(isValidPan, 'Enter a valid 10-character PAN');
const pincode = z.string().trim().refine(isValidPincode, 'Enter a 6-digit PIN code');
const tags = z.array(z.string().trim().toLowerCase().min(1).max(30)).max(20).transform(unique);
const roles = z.array(z.enum(PARTY_ROLES)).min(1).max(PARTY_ROLES.length).transform(unique);

const customerFields = {
  customerType: z.enum(CUSTOMER_TYPES),
  assignedMemberId: z.uuid().nullable(),
  preferredContact: z.enum(CONTACT_METHODS),
};

export const createPartySchema = z
  .object({
    kind: z.enum(['person', 'organization']).default('person'),
    displayName: z.string().trim().min(2).max(160),
    legalName: text(160).optional(),
    contactPerson: text(120).optional(),
    phone: phone.optional(),
    alternatePhone: phone.optional(),
    email: email.optional(),
    gstin: gstin.optional(),
    pan: pan.optional(),
    addressLine: text(300).optional(),
    city: text(80).optional(),
    state: text(80).optional(),
    pincode: pincode.optional(),
    homeStoreId: z.uuid().optional(),
    notes: text(2000).optional(),
    tags: tags.default([]),
    roles,
    /** Customer details; only for parties with the customer role. */
    customer: z.object(customerFields).partial().optional(),
  })
  .refine((body) => body.customer === undefined || body.roles.includes('customer'), {
    path: ['customer'],
    message: 'Customer details need the customer role',
  });
export type CreatePartyInput = z.output<typeof createPartySchema>;

/** Every field optional; null clears an optional field. */
export const updatePartySchema = z
  .object({
    kind: z.enum(['person', 'organization']).optional(),
    displayName: z.string().trim().min(2).max(160).optional(),
    legalName: text(160).nullable().optional(),
    contactPerson: text(120).nullable().optional(),
    phone: phone.nullable().optional(),
    alternatePhone: phone.nullable().optional(),
    email: email.nullable().optional(),
    gstin: gstin.nullable().optional(),
    pan: pan.nullable().optional(),
    addressLine: text(300).nullable().optional(),
    city: text(80).nullable().optional(),
    state: text(80).nullable().optional(),
    pincode: pincode.nullable().optional(),
    homeStoreId: z.uuid().nullable().optional(),
    notes: text(2000).nullable().optional(),
    tags: tags.optional(),
    isActive: z.boolean().optional(),
    roles: roles.optional(),
    customer: z.object(customerFields).partial().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type UpdatePartyInput = z.output<typeof updatePartySchema>;

export const listPartiesSchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  role: z.enum(PARTY_ROLES).optional(),
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListPartiesQuery = z.output<typeof listPartiesSchema>;
