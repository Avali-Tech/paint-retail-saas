import {
  GST_REGISTRATION_TYPES,
  isCurrentGstStateCode,
  isValidGstin,
  isValidPincode,
} from '@paint/shared';
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.iso.date('Use a date like 2026-04-01');

export const taxCategoryName = z.string().trim().min(2).max(80);
/** Basis points: 1800 = 18%. */
export const rateBps = z.number().int().min(0).max(10_000);

export const createTaxCategorySchema = z.object({
  name: taxCategoryName,
  rateBps,
  /** When the first rate starts; today (India time) when left out. */
  effectiveFrom: isoDate.optional(),
});
export type CreateTaxCategoryInput = z.output<typeof createTaxCategorySchema>;

export const updateTaxCategorySchema = z
  .object({
    name: taxCategoryName.optional(),
    isActive: z.boolean().optional(),
    /** Only `true`: the default moves to this category. */
    isDefault: z.literal(true).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type UpdateTaxCategoryInput = z.output<typeof updateTaxCategorySchema>;

export const addTaxRateSchema = z.object({ rateBps, effectiveFrom: isoDate });
export type AddTaxRateInput = z.output<typeof addTaxRateSchema>;

export const businessGstSchema = z.object({ legalName: text(160).nullable() });
export type BusinessGstInput = z.output<typeof businessGstSchema>;

export const storeGstSchema = z
  .object({
    registrationType: z.enum(GST_REGISTRATION_TYPES),
    stateCode: z.string().trim().refine(isCurrentGstStateCode, 'Choose a state'),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .refine(isValidGstin, 'Enter a valid GSTIN (check for typos)')
      .optional(),
    /** Defaults to the business's legal name. */
    legalName: text(160).optional(),
    tradeName: text(160).optional(),
    addressLine: text(300).optional(),
    city: text(80).optional(),
    pincode: z.string().trim().refine(isValidPincode, 'Enter a 6-digit PIN code').optional(),
  })
  .refine((body) => body.registrationType === 'unregistered' || body.gstin !== undefined, {
    path: ['gstin'],
    message: 'Enter the GSTIN of this registration',
  })
  .refine((body) => body.registrationType !== 'unregistered' || body.gstin === undefined, {
    path: ['gstin'],
    message: 'An unregistered store has no GSTIN',
  })
  .refine((body) => body.gstin === undefined || body.gstin.startsWith(body.stateCode), {
    path: ['gstin'],
    message: 'This GSTIN belongs to another state',
  });
export type StoreGstInput = z.output<typeof storeGstSchema>;
