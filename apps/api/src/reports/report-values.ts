import { paiseToRupees } from '@paint/shared';
import { sql, type AnyColumn } from 'drizzle-orm';

// How report cells read: moments in India time, rupees from paise, quantities to 3 decimals.

/** A moment as people in India read it, e.g. "2026-10-01 18:05". */
export const ist = (column: AnyColumn) =>
  sql<string | null>`to_char(${column} at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')`;
export const rupees = (paise: unknown) =>
  paise === null ? null : paiseToRupees(Math.round(Number(paise)));
export const quantity = (value: unknown) =>
  value === null ? null : Math.round(Number(value) * 1000) / 1000;
export const text = (value: unknown) => value as string | null;
