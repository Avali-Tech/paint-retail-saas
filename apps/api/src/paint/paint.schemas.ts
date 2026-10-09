import {
  COLORANT_MAX_LENGTH,
  COLORANT_UNITS,
  ESTIMATE_NOTE_MAX_LENGTH,
  ESTIMATE_STATUSES,
  ESTIMATE_TIERS,
  ESTIMATE_TITLE_MAX_LENGTH,
  MAX_COATS,
  MAX_ESTIMATE_SURFACES,
  MAX_FORMULA_COMPONENTS,
  MAX_LINE_QUANTITY,
  MAX_SURFACE_AREA_SQFT,
  MAX_SURFACE_DIMENSION_FT,
  MAX_WASTAGE_BPS,
  MIN_COATS,
  SALES_NOTE_MAX_LENGTH,
  ROOM_MAX_LENGTH,
  SHADE_CODE_MAX_LENGTH,
  SHADE_NAME_MAX_LENGTH,
  SURFACE_CONDITIONS,
  SURFACE_KINDS,
  TINT_LINE_KINDS,
  TINT_MACHINE_MAX_LENGTH,
  TINT_NOTE_MAX_LENGTH,
  hasAtMostThreeDecimals,
  hasAtMostTwoDecimals,
  normalizeShadeCode,
  surfaceGrossAreaSqft,
  type ConvertEstimateRequest,
  type EstimateRequest,
  type LineTintRequest,
  type TintRecordRequest,
} from '@paint/shared';
import { z } from 'zod';

// The request shapes are the contract's (@paint/shared paint-api); each schema
// below is checked against it with `satisfies`, so the two cannot drift apart.

const text = (max: number) => z.string().trim().min(1).max(max);
const paise = z.number().int().min(0).max(1_000_000_000_000);
const positive = (max: number, decimals: 2 | 3) =>
  z
    .number()
    .positive('Must be more than zero')
    .max(max)
    .refine(
      decimals === 2 ? hasAtMostTwoDecimals : hasAtMostThreeDecimals,
      `Use at most ${String(decimals)} decimals`,
    );
const flag = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();
const page = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

/** A shade code, normalised (trimmed, single spaces, upper case). */
export const shadeCode = z
  .string()
  .max(SHADE_CODE_MAX_LENGTH * 4)
  .transform((value, context) => {
    const code = normalizeShadeCode(value);
    if (code === null) {
      context.addIssue({
        code: 'custom',
        message: `Enter a shade code of 1 to ${String(SHADE_CODE_MAX_LENGTH)} characters`,
      });
      return z.NEVER;
    }
    return code;
  });

/** A tint's own fields: sent with a line (LineTintRequest) or on its own (POST /tint-records). */
const tintFields = {
  shadeCode,
  shadeName: text(SHADE_NAME_MAX_LENGTH).optional(),
  brandId: z.uuid().optional(),
  packQuantity: positive(MAX_LINE_QUANTITY, 3).optional(),
  colorantCostPaise: paise.optional(),
  tintChargePaise: paise.optional(),
  machine: text(TINT_MACHINE_MAX_LENGTH).optional(),
  formula: z
    .array(
      z.object({
        colorant: text(COLORANT_MAX_LENGTH),
        amount: positive(1_000_000, 3),
        unit: z.enum(COLORANT_UNITS),
      }),
    )
    .max(MAX_FORMULA_COMPONENTS)
    .optional(),
  note: text(TINT_NOTE_MAX_LENGTH).optional(),
};

export const lineTintSchema = z.object(tintFields) satisfies z.ZodType<LineTintRequest>;
export type LineTintInput = z.output<typeof lineTintSchema>;

export const tintRecordSchema = z.object({
  lineKind: z.enum(TINT_LINE_KINDS),
  lineId: z.uuid(),
  ...tintFields,
}) satisfies z.ZodType<TintRecordRequest>;
export type TintRecordInput = z.output<typeof tintRecordSchema>;

export const listTintRecordsSchema = z
  .object({
    partyId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    storeId: z.uuid().optional(),
    shadeCode: shadeCode.optional(),
    q: z.string().trim().min(1).max(80).optional(),
    billed: flag,
    documentKind: z.enum(['quotation', 'sales_order', 'invoice']).optional(),
    documentId: z.uuid().optional(),
    ...page,
  })
  .refine((query) => (query.documentKind === undefined) === (query.documentId === undefined), {
    path: ['documentId'],
    message: 'Give documentKind and documentId together',
  });
export type ListTintRecordsQuery = z.output<typeof listTintRecordsSchema>;

const surface = z
  .object({
    room: text(ROOM_MAX_LENGTH),
    kind: z.enum(SURFACE_KINDS),
    areaSqft: positive(MAX_SURFACE_AREA_SQFT, 2).optional(),
    lengthFt: positive(MAX_SURFACE_DIMENSION_FT, 2).optional(),
    heightFt: positive(MAX_SURFACE_DIMENSION_FT, 2).optional(),
    openingsSqft: z
      .number()
      .min(0)
      .max(MAX_SURFACE_AREA_SQFT)
      .refine(hasAtMostTwoDecimals, 'Use at most 2 decimals')
      .optional(),
    condition: z.enum(SURFACE_CONDITIONS),
    coats: z.number().int().min(MIN_COATS).max(MAX_COATS).optional(),
    primer: z.boolean().optional(),
    putty: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    const byArea = value.areaSqft !== undefined;
    const byLength = value.lengthFt !== undefined || value.heightFt !== undefined;
    if (byArea === byLength) {
      context.addIssue({
        code: 'custom',
        path: ['areaSqft'],
        message: 'Give either the area, or the length and height',
      });
      return;
    }
    if (!byArea && (value.lengthFt === undefined || value.heightFt === undefined)) {
      context.addIssue({
        code: 'custom',
        path: [value.lengthFt === undefined ? 'lengthFt' : 'heightFt'],
        message: 'Give both the length and the height',
      });
      return;
    }
    // Never above MAX_SURFACE_AREA_SQFT either way (1,000 ft × 1,000 ft at most).
    if ((value.openingsSqft ?? 0) > surfaceGrossAreaSqft(value)) {
      context.addIssue({
        code: 'custom',
        path: ['openingsSqft'],
        message: 'Openings cannot be more than the surface',
      });
    }
  });

const option = z.object({
  tier: z.enum(ESTIMATE_TIERS),
  productId: z.uuid(),
  primerProductId: z.uuid().optional(),
  puttyProductId: z.uuid().optional(),
});

export const estimateSchema = z.object({
  storeId: z.uuid(),
  partyId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  title: text(ESTIMATE_TITLE_MAX_LENGTH).optional(),
  wastageBps: z.number().int().min(0).max(MAX_WASTAGE_BPS).optional(),
  note: text(ESTIMATE_NOTE_MAX_LENGTH).optional(),
  surfaces: z.array(surface).min(1).max(MAX_ESTIMATE_SURFACES),
  options: z
    .array(option)
    .max(ESTIMATE_TIERS.length)
    .refine(
      (options) => new Set(options.map((item) => item.tier)).size === options.length,
      'Give each tier once',
    )
    .optional(),
}) satisfies z.ZodType<EstimateRequest>;
export type EstimateInput = z.output<typeof estimateSchema>;

export const listEstimatesSchema = z.object({
  storeId: z.uuid().optional(),
  partyId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  status: z.enum(ESTIMATE_STATUSES).optional(),
  q: z.string().trim().min(1).max(80).optional(),
  ...page,
});
export type ListEstimatesQuery = z.output<typeof listEstimatesSchema>;

/** POST /estimates/:id/convert (round 5b): the tier to quote, with the quotation's validity and note. */
export const convertEstimateSchema = z.object({
  tier: z.enum(ESTIMATE_TIERS),
  validUntil: z.iso.date('Use a date like 2026-04-01').optional(),
  note: text(SALES_NOTE_MAX_LENGTH).optional(),
}) satisfies z.ZodType<ConvertEstimateRequest>;
export type ConvertEstimateInput = z.output<typeof convertEstimateSchema>;
