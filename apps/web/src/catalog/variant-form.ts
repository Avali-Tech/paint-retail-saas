import { VARIANT_LABEL_MAX_LENGTH, isValidBarcode, normalizeVariantLabel } from '@paint/shared';
import { z } from 'zod';
import { UNITS, type Variant, type VariantChanges, type VariantInput } from '../api/catalog.js';
import type { I18n } from '../i18n/i18n.js';
import { parseRupees, rupeesInput } from '../lib/inputs.js';
import { parseQuantity } from '../lib/quantity.js';

/** The API's SKU rule: 2 to 40 letters, digits or . _ / - (upper-cased). */
export const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{1,39}$/;

/** The API's limits: the largest pack and the most barcodes on one pack size. */
export const MAX_PACK_SIZE = 1_000_000;
export const MAX_BARCODES = 10;

/**
 * Barcodes as typed or scanned: separated by commas, semicolons, bars or spaces
 * (the import's column uses ; or |), without repeats.
 */
export function splitBarcodes(text: string): string[] {
  return [...new Set(text.split(/[\s,;|]+/).filter((code) => code !== ''))];
}

/** A pack size as typed into the form. */
export interface VariantDraft {
  sku: string;
  packSize: string;
  unit: (typeof UNITS)[number];
  /** Optional: what tells same-sized packs apart, e.g. "2 inch". */
  label: string;
  mrp: string;
  sellingPrice: string;
  barcodes: string;
  isActive: boolean;
}

export const EMPTY_VARIANT: VariantDraft = {
  sku: '',
  packSize: '',
  unit: 'l',
  label: '',
  mrp: '',
  sellingPrice: '',
  barcodes: '',
  isActive: true,
};

export function variantDraft(variant: Variant): VariantDraft {
  return {
    sku: variant.sku,
    packSize: String(variant.packSize),
    unit: variant.unit,
    label: variant.label ?? '',
    mrp: rupeesInput(variant.mrpPaise),
    sellingPrice: rupeesInput(variant.sellingPricePaise),
    barcodes: variant.barcodes.join(', '),
    isActive: variant.isActive,
  };
}

const price = (text: string) => (text.trim() === '' ? null : parseRupees(text));

/** Checks a pack size the way the API does: SKU, size, prices (selling ≤ MRP) and barcode check digits. */
export function variantSchema(t: I18n['t']) {
  return z
    .object({
      sku: z
        .string()
        .refine(
          (value) => SKU_PATTERN.test(value.trim().toUpperCase()),
          t('products.form.skuInvalid'),
        ),
      packSize: z.string().refine((value) => {
        const size = parseQuantity(value);
        return size !== null && size > 0 && size <= MAX_PACK_SIZE;
      }, t('products.form.packSizeInvalid')),
      unit: z.enum(UNITS),
      label: z
        .string()
        .refine(
          (value) => value.trim().length <= VARIANT_LABEL_MAX_LENGTH,
          t('products.form.labelTooLong', { max: VARIANT_LABEL_MAX_LENGTH }),
        ),
      mrp: z
        .string()
        .refine(
          (value) => value.trim() === '' || (price(value) ?? -1) >= 0,
          t('products.form.priceInvalid'),
        ),
      sellingPrice: z
        .string()
        .refine(
          (value) => value.trim() === '' || (price(value) ?? -1) >= 0,
          t('products.form.priceInvalid'),
        ),
      barcodes: z.string(),
      isActive: z.boolean(),
    })
    .superRefine((draft, context) => {
      const codes = splitBarcodes(draft.barcodes);
      const bad = codes.find((code) => !isValidBarcode(code));
      if (codes.length > MAX_BARCODES) {
        context.addIssue({
          code: 'custom',
          path: ['barcodes'],
          message: t('products.form.tooManyBarcodes', { max: MAX_BARCODES }),
        });
      } else if (bad !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['barcodes'],
          message: t('products.form.barcodeInvalid', { code: bad }),
        });
      }
      const mrp = price(draft.mrp);
      const selling = price(draft.sellingPrice);
      if (mrp !== null && selling !== null && selling > mrp) {
        context.addIssue({
          code: 'custom',
          path: ['sellingPrice'],
          message: t('products.form.aboveMrp'),
        });
      }
    });
}

/** A checked draft as the body of POST /products/:id/variants (or a line of POST /products). */
export function toVariantInput(draft: VariantDraft): VariantInput {
  const mrp = price(draft.mrp);
  const selling = price(draft.sellingPrice);
  return {
    sku: draft.sku.trim().toUpperCase(),
    packSize: Number(parseQuantity(draft.packSize)),
    unit: draft.unit,
    label: normalizeVariantLabel(draft.label),
    ...(mrp === null ? {} : { mrpPaise: mrp }),
    ...(selling === null ? {} : { sellingPricePaise: selling }),
    barcodes: splitBarcodes(draft.barcodes),
  };
}

/** The changes for PATCH /variants/:id: prices and barcodes replace, empty prices clear. */
export function toVariantChanges(draft: VariantDraft): VariantChanges {
  return {
    sku: draft.sku.trim().toUpperCase(),
    label: normalizeVariantLabel(draft.label),
    mrpPaise: price(draft.mrp),
    sellingPricePaise: price(draft.sellingPrice),
    barcodes: splitBarcodes(draft.barcodes),
    isActive: draft.isActive,
  };
}
