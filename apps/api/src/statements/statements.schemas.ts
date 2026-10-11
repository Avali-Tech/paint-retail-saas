import type { StatementQuery } from '@paint/shared';
import { z } from 'zod';

const isoDate = z.iso.date('Use a date like 2026-04-01');

export const statementQuerySchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((query) => query.from <= query.to, {
    message: 'The end date cannot be before the start date',
    path: ['to'],
  }) satisfies z.ZodType<StatementQuery>;
export type StatementQueryInput = z.output<typeof statementQuerySchema>;

/** The statement PDF: the period, and the language printed under the English labels. */
export const statementPdfQuerySchema = z
  .object({ from: isoDate, to: isoDate, lang: z.enum(['en', 'hi', 'te']).default('en') })
  .refine((query) => query.from <= query.to, {
    message: 'The end date cannot be before the start date',
    path: ['to'],
  });
export type StatementPdfQueryInput = z.output<typeof statementPdfQuerySchema>;
