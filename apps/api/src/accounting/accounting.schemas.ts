import {
  ACCOUNTING_EXPORT_FORMATS,
  ACCOUNTING_EXPORT_KINDS,
  LEDGER_MATCH_FIELDS,
  PAYMENT_MODE_KINDS,
  SUPPLY_TYPES,
  TALLY_GROUPS,
  TALLY_LEDGER_PURPOSES,
  TAX_NATURES,
  type LedgerMatchField,
} from '@paint/shared';
import { z } from 'zod';

const isoDate = z.iso.date('Use a date like 2026-04-01');

const MATCH_FIELDS = [
  'rateBasisPoints',
  'nature',
  'supplyType',
  'storeId',
  'modeKind',
  'modeId',
  'partyId',
] as const satisfies readonly LedgerMatchField[];

/** One override of a default Tally ledger; it may only match on facts its purpose has. */
export const ledgerMappingSchema = z
  .object({
    purpose: z.enum(TALLY_LEDGER_PURPOSES),
    rateBasisPoints: z.number().int().min(0).max(10_000).optional(),
    nature: z.enum(TAX_NATURES).optional(),
    supplyType: z.enum(SUPPLY_TYPES).optional(),
    storeId: z.uuid().optional(),
    modeKind: z.enum(PAYMENT_MODE_KINDS).optional(),
    modeId: z.uuid().optional(),
    partyId: z.uuid().optional(),
    ledgerName: z.string().trim().min(1, 'Enter the ledger name as it is in Tally').max(200),
    group: z.enum(TALLY_GROUPS).optional(),
    position: z.number().int().min(0).max(10_000).default(0),
  })
  .superRefine((body, context) => {
    const allowed: readonly LedgerMatchField[] = LEDGER_MATCH_FIELDS[body.purpose];
    for (const field of MATCH_FIELDS) {
      if (body[field] !== undefined && !allowed.includes(field)) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'This ledger cannot be matched on this',
        });
      }
    }
  });
export type LedgerMappingInput = z.output<typeof ledgerMappingSchema>;

/** `kinds=sales,receipt`: at least one, no repeats. */
const kindsSchema = z
  .string()
  .transform((value) => value.split(',').map((kind) => kind.trim()))
  .pipe(
    z
      .array(z.enum(ACCOUNTING_EXPORT_KINDS))
      .min(1)
      .refine((kinds) => new Set(kinds).size === kinds.length, 'Name each kind once'),
  );

const period = {
  from: isoDate,
  to: isoDate,
};
const periodOrder = (body: { from: string; to: string }) => body.from <= body.to;
const PERIOD_ORDER = { message: 'The period ends before it starts', path: ['to'] };

export const exportPreviewSchema = z
  .object({ ...period, kinds: kindsSchema })
  .refine(periodOrder, PERIOD_ORDER);
export type ExportPreviewQuery = z.output<typeof exportPreviewSchema>;

export const createExportSchema = z
  .object({
    ...period,
    kinds: z
      .array(z.enum(ACCOUNTING_EXPORT_KINDS))
      .min(1)
      .refine((kinds) => new Set(kinds).size === kinds.length, 'Name each kind once'),
    format: z.enum(ACCOUNTING_EXPORT_FORMATS),
    companyName: z.string().trim().min(1).max(200).optional(),
  })
  .refine(periodOrder, PERIOD_ORDER);
export type CreateExportInput = z.output<typeof createExportSchema>;

export const listExportsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListExportsQuery = z.output<typeof listExportsSchema>;
