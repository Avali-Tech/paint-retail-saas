import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  afterKey,
  cursorParam,
  decodeCursor,
  encodeCursor,
  keysetPage,
  keysetSlice,
  NEWEST_FIRST,
  pageOffset,
  type Keyset,
} from './keyset.js';

const AT = '2026-10-09T08:15:30.123456Z';
const ID = '0b5c6f2e-6a51-4c3e-9d0a-2f1e3c4b5a69';
const LEDGER: Keyset = { order: 'asc', parts: ['date', 'timestamp', 'uuid'] };
const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('cursors', () => {
  it('round-trip a sort key', () => {
    expect(decodeCursor(encodeCursor([AT, ID]), NEWEST_FIRST.parts)).toEqual([AT, ID]);
    expect(decodeCursor(encodeCursor(['2026-02-28', AT, ID]), LEDGER.parts)).toEqual([
      '2026-02-28',
      AT,
      ID,
    ]);
  });

  it.each([
    ['not base64 JSON', 'nonsense!'],
    ['not a list', raw({ at: AT, id: ID })],
    ['the wrong length', raw([AT])],
    ['a number for a time', raw([1, ID])],
    ['a time without microseconds', raw(['2026-10-09T08:15:30.123Z', ID])],
    ['an hour past 23', raw(['2026-10-09T24:15:30.123456Z', ID])],
    ['a day that does not exist', raw(['2026-02-30T08:15:30.123456Z', ID])],
    ['a month that does not exist', raw(['2026-13-01T08:15:30.123456Z', ID])],
    ['SQL in place of an id', raw([AT, "x'; drop table payments; --"])],
  ])('refuse %s', (_, cursor) => {
    expect(decodeCursor(cursor, NEWEST_FIRST.parts)).toBeNull();
  });

  it('refuse a date that is not a day', () => {
    expect(decodeCursor(raw(['2026-02-29', AT, ID]), LEDGER.parts)).toBeNull();
  });
});

describe('the cursor parameter', () => {
  const query = z.object(keysetPage);

  it('decodes a cursor and keeps limit and offset defaults', () => {
    expect(query.parse({ cursor: encodeCursor([AT, ID]) })).toEqual({
      limit: 50,
      offset: 0,
      cursor: [AT, ID],
    });
    expect(query.parse({})).toEqual({ limit: 50, offset: 0 });
  });

  it('names the parameter when the cursor is not one', () => {
    const result = z.object({ cursor: cursorParam(LEDGER) }).safeParse({
      cursor: encodeCursor([AT, ID]),
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['cursor'],
        message: 'This list position is not valid; start again from the first page',
      }),
    ]);
  });
});

describe('paging', () => {
  const dialect = new PgDialect();

  it('compares the whole key at once, newest first or oldest first', () => {
    const newest = dialect.sqlToQuery(
      afterKey(NEWEST_FIRST, [sql.raw('created_at'), sql.raw('id')], [AT, ID]) ?? sql``,
    );
    expect(newest.sql).toBe('(created_at, id) < ($1::timestamptz, $2::uuid)');
    expect(newest.params).toEqual([AT, ID]);
    const oldest = dialect.sqlToQuery(
      afterKey(
        LEDGER,
        [sql.raw('entry_on'), sql.raw('created_at'), sql.raw('id')],
        ['2026-10-09', AT, ID],
      ) ?? sql``,
    );
    expect(oldest.sql).toBe('(entry_on, created_at, id) > ($1::date, $2::timestamptz, $3::uuid)');
    expect(afterKey(NEWEST_FIRST, [sql.raw('id')], undefined)).toBeUndefined();
  });

  it('starts from the cursor when there is one, else from the offset', () => {
    expect(pageOffset({ limit: 50, offset: 100 })).toBe(100);
    expect(pageOffset({ limit: 50, offset: 100, cursor: [AT, ID] })).toBe(0);
  });

  it('gives a next cursor only when the extra row shows there is more', () => {
    const rows = [1, 2, 3].map((n) => ({ id: String(n) }));
    expect(keysetSlice(rows, 3, (row) => [row.id])).toEqual({ rows, nextCursor: null });
    const page = keysetSlice(rows, 2, (row) => [row.id]);
    expect(page.rows).toEqual(rows.slice(0, 2));
    expect(page.nextCursor).toBe(encodeCursor(['2']));
  });
});
