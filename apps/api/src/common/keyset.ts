import type { Transaction } from '@paint/db';
import { LIST_COUNT_CAP, type ListPageInfo } from '@paint/shared';
import { count, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { PgSelect } from 'drizzle-orm/pg-core';
import { z } from 'zod';

// Keyset paging for the MVP 2 lists (round 6c). A cursor is the sort key of a page's
// last row, so the next page starts from the index right after it: page 500 reads 50
// index entries, not 25,000. `offset` still works (a shared link to ?offset=100).

/** A part of a sort key, checked before it reaches SQL. */
export type CursorPart = 'timestamp' | 'date' | 'uuid';

const PATTERNS: Record<CursorPart, RegExp> = {
  timestamp: /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
};
const CASTS: Record<CursorPart, string> = { timestamp: 'timestamptz', date: 'date', uuid: 'uuid' };

/** A real calendar day (not 2026-02-30), for the date parts of a key. */
function isRealDay(value: string): boolean {
  const day = value.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

export function encodeCursor(values: readonly string[]): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

/** The key in a cursor, or null when it is not one of `parts`' shape. */
export function decodeCursor(cursor: string, parts: readonly CursorPart[]): string[] | null {
  let values: unknown;
  try {
    values = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(values) || values.length !== parts.length) return null;
  const valid = parts.every((part, index) => {
    const value: unknown = values[index];
    return (
      typeof value === 'string' &&
      PATTERNS[part].test(value) &&
      (part === 'uuid' || isRealDay(value))
    );
  });
  return valid ? (values as string[]) : null;
}

/** A sort order: the direction and what each key column holds. */
export interface Keyset {
  readonly order: 'asc' | 'desc';
  readonly parts: readonly CursorPart[];
}

/** Newest first by creation time, then id: every MVP 2 document list. */
export const NEWEST_FIRST: Keyset = { order: 'desc', parts: ['timestamp', 'uuid'] };

/** `?cursor=`: a key of `keyset`'s shape, or a 400 naming the parameter. */
export function cursorParam(keyset: Keyset) {
  return z
    .string()
    .max(400)
    .transform((value, context) => {
      const key = decodeCursor(value, keyset.parts);
      if (key === null) {
        context.addIssue({
          code: 'custom',
          message: 'This list position is not valid; start again from the first page',
        });
        return z.NEVER;
      }
      return key;
    })
    .optional();
}

/** `limit`, `offset` and `cursor` for a newest-first list (a cursor wins over an offset). */
export const keysetPage = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  cursor: cursorParam(NEWEST_FIRST),
};

/** The paging part of a list query, once validated. */
export interface KeysetQuery {
  readonly limit: number;
  readonly offset: number;
  readonly cursor?: string[] | undefined;
}

/** Rows strictly after `key` in `keyset`'s order, as one row comparison the index answers. */
export function afterKey(
  keyset: Keyset,
  columns: readonly (AnyColumn | SQL)[],
  key: readonly string[] | undefined,
): SQL | undefined {
  if (key === undefined) return undefined;
  const values = keyset.parts.map((part, index) => sql`${key[index]}::${sql.raw(CASTS[part])}`);
  return sql`(${sql.join([...columns], sql`, `)}) ${sql.raw(keyset.order === 'desc' ? '<' : '>')} (${sql.join(values, sql`, `)})`;
}

/**
 * A timestamp column as exact text (microseconds, UTC) for a cursor: a JavaScript Date
 * keeps only milliseconds, and a key rounded down would repeat or skip rows.
 */
export function cursorTime(column: AnyColumn): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Where a page of `limit + 1` fetched rows starts: the cursor, else the offset. */
export function pageOffset(query: KeysetQuery): number {
  return query.cursor === undefined ? query.offset : 0;
}

/**
 * The page from `limit + 1` fetched rows: the first `limit`, and a cursor after the
 * last of them when the extra row shows there is more.
 */
export function keysetSlice<R>(
  rows: R[],
  limit: number,
  keyOf: (row: R) => readonly string[],
): { rows: R[]; nextCursor: string | null } {
  if (rows.length <= limit) return { rows, nextCursor: null };
  const page = rows.slice(0, limit);
  return { rows: page, nextCursor: encodeCursor(keyOf(page[limit - 1] as R)) };
}

/**
 * How many rows match, counted up to {@link LIST_COUNT_CAP}: `matching` selects them
 * (any columns); counting stops after the cap, so it stays quick at any size.
 */
export async function cappedTotal(
  tx: Transaction,
  matching: PgSelect,
): Promise<Pick<ListPageInfo, 'total' | 'totalCapped'>> {
  const [row] = await tx
    .select({ value: count() })
    .from(matching.limit(LIST_COUNT_CAP + 1).as('matching'));
  const value = Number(row?.value);
  return { total: Math.min(value, LIST_COUNT_CAP), totalCapped: value > LIST_COUNT_CAP };
}
