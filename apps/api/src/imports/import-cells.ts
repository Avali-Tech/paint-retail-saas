import { rupeesToPaise } from '@paint/shared';
import { z } from 'zod';

// Parsers for spreadsheet cells, which always arrive as (trimmed) text.

/** A cell that must be filled in, then checked by `schema`. */
export const required = <T extends z.ZodType<unknown, string>>(schema: T) =>
  z.string().min(1, 'Required').pipe(schema);

/** A cell that may be left blank (giving undefined), else checked by `schema`. */
export const optional = <T extends z.ZodType<unknown, string>>(schema: T) =>
  z
    .string()
    .transform((value) => (value === '' ? undefined : value))
    .pipe(schema.optional());

export const text = (min: number, max: number) =>
  z
    .string()
    .min(min, `Use at least ${String(min)} characters`)
    .max(max, `Use at most ${String(max)} characters`);

/** A plain number such as 1, 2.5 or 1,000. */
export const decimal = z
  .string()
  .transform((value) => value.replaceAll(',', ''))
  .pipe(z.string().regex(/^-?\d+(\.\d+)?$/, 'Enter a number'))
  .transform(Number);

/** Rupees such as 650, 650.50, ₹1,250 or 8,50,000; gives paise. */
export const rupees = z
  .string()
  .transform((value, context) => {
    try {
      return rupeesToPaise(value.replace(/^₹\s*/, ''));
    } catch {
      context.addIssue({ code: 'custom', message: 'Enter an amount in rupees, such as 1250.50' });
      return z.NEVER;
    }
  })
  .pipe(z.number().min(0, 'Cannot be negative'));

/** One of `values`, written in any case with spaces or hyphens: "Exterior Paint" → exterior_paint. */
export const choice = <const T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((value) =>
      value
        .trim()
        .toLowerCase()
        .replaceAll(/[\s-]+/g, '_'),
    )
    .pipe(z.enum(values, { error: `Use one of: ${values.join(', ')}` }));

/** Several values in one cell, separated by ; or | — repeats removed. */
export const list = z.string().transform((value) => [
  ...new Set(
    value
      .split(/[;|]/)
      .map((item) => item.trim())
      .filter((item) => item !== ''),
  ),
]);

/**
 * A date such as 2026-04-01, 01-04-2026 or 01/04/2026 (day first, as written
 * in India); gives YYYY-MM-DD.
 */
export const date = z.string().transform((value, context) => {
  const dayFirst = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value);
  const iso = dayFirst
    ? `${String(dayFirst[3])}-${String(dayFirst[2]).padStart(2, '0')}-${String(dayFirst[1]).padStart(2, '0')}`
    : value;
  // A real calendar day: 2026-02-30 rolls over and is refused.
  const time = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? Date.parse(`${iso}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== iso) {
    context.addIssue({ code: 'custom', message: 'Enter a date such as 2026-04-01 or 01-04-2026' });
    return z.NEVER;
  }
  return iso;
});
