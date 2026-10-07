import { schema } from '@paint/db';
import { VARIANT_LABEL_MAX_LENGTH, isValidBarcode, isValidHsn } from '@paint/shared';
import { z } from 'zod';

export const PRODUCT_TYPES = schema.productType.enumValues;
export const UNITS = schema.unitOfMeasure.enumValues;

export const catalogName = z.string().trim().min(2).max(120);
const name = catalogName;
const unique = <T>(values: T[]) => [...new Set(values)];
const paise = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const sku = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9._/-]{1,39}$/, 'Use 2 to 40 letters, digits or . _ / -');
export const barcode = z
  .string()
  .trim()
  .refine(isValidBarcode, 'Barcode is not valid (check digit or characters)');
const barcodes = z.array(barcode).max(10).transform(unique);
export const packSize = z
  .number()
  .positive()
  .max(1_000_000)
  .refine(
    (value) => Math.abs(Math.round(value * 1000) - value * 1000) < 1e-6,
    'Use at most 3 decimals',
  );
/** What tells same-sized packs apart ("2 inch", "Grit 120"); blank means none. */
export const variantLabel = z
  .string()
  .trim()
  .max(VARIANT_LABEL_MAX_LENGTH)
  .transform((value) => (value === '' ? null : value));
export const hsnCode = z.string().trim().refine(isValidHsn, 'Enter a 4, 6 or 8-digit HSN code');

const withinMrp = (variant: { mrpPaise?: number | null; sellingPricePaise?: number | null }) =>
  variant.mrpPaise == null ||
  variant.sellingPricePaise == null ||
  variant.sellingPricePaise <= variant.mrpPaise;
const withinMrpMessage = {
  path: ['sellingPricePaise'],
  message: 'Selling price cannot exceed the MRP',
};

export const brandSchema = z.object({ name });
export const updateBrandSchema = z
  .object({ name: name.optional(), isActive: z.boolean().optional() })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

export const categorySchema = z.object({ name, parentId: z.uuid().optional() });
export const updateCategorySchema = z
  .object({ name: name.optional(), isActive: z.boolean().optional() })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

export const variantSchema = z
  .object({
    sku,
    packSize,
    unit: z.enum(UNITS),
    label: variantLabel.nullable().optional(),
    mrpPaise: paise.optional(),
    sellingPricePaise: paise.optional(),
    barcodes: barcodes.default([]),
  })
  .refine(withinMrp, withinMrpMessage);
export type VariantInput = z.output<typeof variantSchema>;

export const updateVariantSchema = z
  .object({
    sku: sku.optional(),
    /** Renames the variant; null or blank removes the label. */
    label: variantLabel.nullable().optional(),
    mrpPaise: paise.nullable().optional(),
    sellingPricePaise: paise.nullable().optional(),
    isActive: z.boolean().optional(),
    /** Replaces the variant's barcodes. */
    barcodes: barcodes.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' })
  .refine(withinMrp, withinMrpMessage);
export type UpdateVariantInput = z.output<typeof updateVariantSchema>;

export const createProductSchema = z.object({
  brandId: z.uuid(),
  categoryId: z.uuid().optional(),
  name,
  type: z.enum(PRODUCT_TYPES),
  description: z.string().trim().min(1).max(2000).optional(),
  hsnCode,
  /** Where the GST rate comes from; the default category until the business registers for GST. */
  taxCategoryId: z.uuid().optional(),
  variants: z.array(variantSchema).min(1).max(50),
});
export type CreateProductInput = z.output<typeof createProductSchema>;

export const updateProductSchema = z
  .object({
    brandId: z.uuid().optional(),
    categoryId: z.uuid().nullable().optional(),
    name: name.optional(),
    type: z.enum(PRODUCT_TYPES).optional(),
    description: z.string().trim().min(1).max(2000).nullable().optional(),
    hsnCode: hsnCode.optional(),
    taxCategoryId: z.uuid().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type UpdateProductInput = z.output<typeof updateProductSchema>;

const includeInactive = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

export const listProductsSchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  brandId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  type: z.enum(PRODUCT_TYPES).optional(),
  includeInactive,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListProductsQuery = z.output<typeof listProductsSchema>;

export const lookupSchema = z.object({
  code: z.string().trim().min(1).max(64),
  /** Also find discontinued packs and products (e.g. when counting stock still on the shelf). */
  includeInactive,
});
