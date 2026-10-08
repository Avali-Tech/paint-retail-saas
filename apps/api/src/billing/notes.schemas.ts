import { RETURN_DISPOSITIONS, VALUE_CREDIT_NOTE_REASONS, type NoteKind } from '@paint/shared';
import { z } from 'zod';
import { threeDecimals } from './billing.schemas.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const valuePaise = z.number().int().min(1).max(1_000_000_000_000);
const NOTE_KINDS: readonly [NoteKind, NoteKind] = ['credit_note', 'debit_note'];

/** Goods coming back against an issued invoice (spec §4.5), each line to stock or to damage. */
export const salesReturnSchema = z.object({
  invoiceId: z.uuid(),
  lines: z
    .array(
      z.object({
        invoiceLineId: z.uuid(),
        quantity: z
          .number()
          .positive('Quantity must be more than zero')
          .max(1_000_000)
          .refine(threeDecimals, 'Use at most 3 decimals'),
        disposition: z.enum(RETURN_DISPOSITIONS),
        reason: text(200).optional(),
      }),
    )
    .min(1)
    .max(200)
    .refine(
      (lines) =>
        new Set(lines.map((line) => `${line.invoiceLineId}:${line.disposition}`)).size ===
        lines.length,
      'List each invoice line once to stock and once to damage at most',
    ),
  note: text(500).optional(),
});
export type SalesReturnInput = z.output<typeof salesReturnSchema>;

/** Value changes of invoice lines, at most one per line. */
const valueLines = z
  .array(z.object({ invoiceLineId: z.uuid(), valuePaise }))
  .min(1)
  .max(200)
  .refine(
    (lines) => new Set(lines.map((line) => line.invoiceLineId)).size === lines.length,
    'List each invoice line once',
  );

const valueNote = {
  invoiceId: z.uuid(),
  lines: valueLines,
  /** Whether each value includes tax; defaults to the invoice's price mode. */
  valueIncludesTax: z.boolean().optional(),
  note: text(500).optional(),
};

/** A credit note without goods coming back: a discount, an overcharge or deficient goods. */
export const creditNoteSchema = z
  .object({
    ...valueNote,
    reason: z.enum(VALUE_CREDIT_NOTE_REASONS),
    /** s.15(3)(b): the scheme the discount was agreed under before the sale. */
    schemeReference: text(120).optional(),
  })
  .refine((body) => body.reason !== 'discount' || body.schemeReference !== undefined, {
    path: ['schemeReference'],
    message: 'A discount after the sale needs the scheme agreed before it (s.15(3)(b))',
  });
export type CreditNoteInput = z.output<typeof creditNoteSchema>;

/** A debit note for an undercharge (s.34(3)). */
export const debitNoteSchema = z.object(valueNote);
export type DebitNoteInput = z.output<typeof debitNoteSchema>;

export const listNotesSchema = z.object({
  invoiceId: z.uuid().optional(),
  storeId: z.uuid().optional(),
  partyId: z.uuid().optional(),
  kind: z.enum(NOTE_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListNotesQuery = z.output<typeof listNotesSchema>;
