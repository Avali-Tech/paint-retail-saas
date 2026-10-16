import {
  BRAND_STATEMENT_STATUSES,
  DEFAULT_AMOUNT_TOLERANCE_PAISE,
  DEFAULT_DATE_WINDOW_DAYS,
  MAX_AMOUNT_TOLERANCE_PAISE,
  MAX_DATE_WINDOW_DAYS,
  STATEMENT_AMOUNT_MODES,
  STATEMENT_DATE_FORMATS,
  STATEMENT_GRN_BASES,
  STATEMENT_SIGN_CONVENTIONS,
  TYPED_LINE_KINDS,
} from '@paint/shared';
import { z } from 'zod';

const column = z.string().trim().min(1, 'Enter the column’s header').max(60);
const optionalColumn = column.nullable().default(null);
const words = z.array(z.string().trim().min(1).max(40)).max(20);

/** POST /brand-statements/templates and PUT …/:id: how a statement is laid out. */
export const templateSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the template').max(80),
    supplierPartyId: z.uuid(),
    brandId: z.uuid().nullable().default(null),
    headerRowsToSkip: z.number().int().min(0).max(50).default(0),
    dateColumn: column,
    documentColumn: column,
    typeColumn: optionalColumn,
    referenceColumn: optionalColumn,
    descriptionColumn: optionalColumn,
    amountMode: z.enum(STATEMENT_AMOUNT_MODES),
    debitColumn: optionalColumn,
    creditColumn: optionalColumn,
    amountColumn: optionalColumn,
    signConvention: z.enum(STATEMENT_SIGN_CONVENTIONS).default('debit_positive'),
    dateFormat: z.enum(STATEMENT_DATE_FORMATS).default('dd-mm-yyyy'),
    typeRules: z.partialRecord(z.enum(TYPED_LINE_KINDS), words).default({}),
    dateWindowDays: z
      .number()
      .int()
      .min(0)
      .max(MAX_DATE_WINDOW_DAYS)
      .default(DEFAULT_DATE_WINDOW_DAYS),
    amountTolerancePaise: z
      .number()
      .int()
      .min(0)
      .max(MAX_AMOUNT_TOLERANCE_PAISE, 'A tolerance of at most ₹1,000')
      .default(DEFAULT_AMOUNT_TOLERANCE_PAISE),
    grnAmountBasis: z.enum(STATEMENT_GRN_BASES).default('with_gst'),
    isActive: z.boolean().default(true),
  })
  .strict()
  .superRefine((body, context) => {
    const needed =
      body.amountMode === 'debit_credit'
        ? (['debitColumn', 'creditColumn'] as const)
        : (['amountColumn'] as const);
    for (const key of needed) {
      if (body[key] === null) {
        context.addIssue({ code: 'custom', path: [key], message: 'Enter the column’s header' });
      }
    }
  })
  .transform((body) =>
    body.amountMode === 'debit_credit'
      ? { ...body, amountColumn: null }
      : { ...body, debitColumn: null, creditColumn: null },
  );
export type TemplateBody = z.output<typeof templateSchema>;

const isoDate = z.iso.date('Use a date like 2026-09-01');
const signedPaise = z
  .string()
  .trim()
  .regex(/^-?\d{1,11}$/, 'Enter the balance in paise')
  .transform(Number);
const blankToUndefined = (value: unknown) => (value === '' ? undefined : value);

/** The form fields sent with a statement file (multipart). */
export const importFieldsSchema = z
  .object({
    templateId: z.uuid('Choose a template'),
    periodFrom: z.preprocess(blankToUndefined, isoDate.optional()),
    periodTo: z.preprocess(blankToUndefined, isoDate.optional()),
    /** Paise, as printed on the statement; signed like its lines (positive: we owe). */
    openingBalancePaise: z.preprocess(blankToUndefined, signedPaise.optional()),
    closingBalancePaise: z.preprocess(blankToUndefined, signedPaise.optional()),
  })
  .strict()
  .refine(
    (fields) =>
      fields.periodFrom === undefined ||
      fields.periodTo === undefined ||
      fields.periodFrom <= fields.periodTo,
    { message: 'The period ends before it starts', path: ['periodTo'] },
  );
export type ImportFields = z.output<typeof importFieldsSchema>;

/** GET /brand-statements. */
export const listStatementsSchema = z.object({
  supplierPartyId: z.uuid().optional(),
  status: z.enum(BRAND_STATEMENT_STATUSES).optional(),
});
export type ListStatementsQuery = z.output<typeof listStatementsSchema>;

const note = z.string().trim().min(1).max(500);

/** POST /brand-statements/:id/lines/:lineId/match. */
export const manualMatchSchema = z
  .object({
    recordKey: z.string().regex(/^(grn|benefit_receipt):[0-9a-f-]{36}$/, 'Choose a record'),
    note: note.nullable().default(null),
  })
  .strict();
export type ManualMatchBody = z.output<typeof manualMatchSchema>;

/** POST /brand-statements/:id/lines/:lineId/explain. */
export const explainSchema = z.object({ note: note }).strict();
export type ExplainBody = z.output<typeof explainSchema>;

/** POST /brand-statements/:id/lines/:lineId/scheme-receipt. */
export const schemeReceiptSchema = z
  .object({
    schemeId: z.uuid('Choose a scheme'),
    claimId: z.uuid().nullable().default(null),
    note: note.nullable().default(null),
  })
  .strict();
export type SchemeReceiptBody = z.output<typeof schemeReceiptSchema>;
