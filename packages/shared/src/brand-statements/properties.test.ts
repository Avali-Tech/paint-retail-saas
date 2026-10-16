import { describe, expect, it } from 'vitest';
import type { StatementLineKind } from './api.js';
import {
  lineStatus,
  matchStatement,
  statementSummary,
  type AutoMatch,
  type MatchInput,
  type MatchLine,
  type MatchRecord,
} from './match.js';

/** A small seeded generator (mulberry32), so a failure replays exactly. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T;
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  };
  return { int, pick, shuffle, chance: (p: number) => next() < p };
}
type Random = ReturnType<typeof random>;

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);
const day = (offset: number) => new Date(Date.UTC(2026, 8, 1 + offset)).toISOString().slice(0, 10);
const KINDS: StatementLineKind[] = ['invoice', 'credit_note', 'other', 'payment', 'opening'];

/** A month of a brand's statement and our books, with near and far amounts and shared numbers. */
function randomBooks(r: Random): MatchInput {
  const amounts = Array.from({ length: 6 }, () => r.int(1, 2_00_000) * 100);
  const numbers = Array.from({ length: 8 }, (_, i) => `INV/${String(100 + i)}`);
  const lines: MatchLine[] = Array.from({ length: r.int(0, 25) }, (_, i) => {
    const kind = r.pick(KINDS);
    const debit = kind === 'invoice' || (kind !== 'credit_note' && r.chance(0.5));
    return {
      id: `line-${String(i).padStart(3, '0')}`,
      rowNumber: i + 2,
      lineDate: day(r.int(0, 29)),
      kind,
      documentNumber: r.chance(0.6) ? r.pick(numbers) : null,
      reference: r.chance(0.2) ? r.pick(numbers).toLowerCase() : null,
      amountPaise: (debit ? 1 : -1) * (r.pick(amounts) + r.pick([0, 0, 50, 99, 150, 5_000])),
    };
  });
  const records: MatchRecord[] = Array.from({ length: r.int(0, 25) }, (_, i) => ({
    key: `${r.pick(['grn', 'benefit_receipt'])}:${String(i).padStart(3, '0')}`,
    date: day(r.int(-5, 34)),
    references: r.chance(0.6) ? [r.pick(numbers)] : [null],
    amountPaise: (r.chance(0.7) ? 1 : -1) * (r.pick(amounts) + r.pick([0, 0, 40, 100, 2_000])),
  }));
  return {
    lines,
    records,
    fixed: [],
    rejected: [],
    elsewhere: new Set(records.filter(() => r.chance(0.05)).map((record) => record.key)),
    tolerance: { dateWindowDays: r.int(0, 10), amountTolerancePaise: r.pick([0, 50, 100, 1_000]) },
  };
}

const at = (seed: number) => `seed ${String(seed)}`;
const pairs = (matches: readonly AutoMatch[]) => matches.map((m) => `${m.lineId}>${m.recordKey}`);

describe('matching properties', () => {
  it('gives the same pairs whatever order the lines and records come in', () => {
    for (const seed of SEEDS) {
      const r = random(seed);
      const books = randomBooks(r);
      const shuffled = {
        ...books,
        lines: r.shuffle(books.lines),
        records: r.shuffle(books.records),
      };
      expect(matchStatement(shuffled), at(seed)).toEqual(matchStatement(books));
    }
  });

  it('is idempotent: run again, or with some of its pairs fixed by a member, the rest stays', () => {
    for (const seed of SEEDS) {
      const r = random(seed);
      const books = randomBooks(r);
      const first = matchStatement(books);
      expect(matchStatement(books), at(seed)).toEqual(first);
      const kept = first.filter(() => r.chance(0.4));
      const again = matchStatement({
        ...books,
        fixed: kept.map((match) => ({ lineId: match.lineId, recordKey: match.recordKey })),
      });
      const keptPairs = new Set(pairs(kept));
      expect(pairs(again), at(seed)).toEqual(pairs(first).filter((pair) => !keptPairs.has(pair)));
    }
  });

  it('pairs each line and record once, same sign, never a fixed, rejected or elsewhere record', () => {
    for (const seed of SEEDS) {
      const r = random(seed);
      const books = randomBooks(r);
      const rejected = books.lines
        .flatMap((line) =>
          books.records.map((record) => ({ lineId: line.id, recordKey: record.key })),
        )
        .filter(() => r.chance(0.05));
      const matches = matchStatement({ ...books, rejected });
      const lines = new Map(books.lines.map((line) => [line.id, line]));
      const records = new Map(books.records.map((record) => [record.key, record]));
      const rejectedPairs = new Set(rejected.map((pair) => `${pair.lineId}>${pair.recordKey}`));
      expect(new Set(matches.map((m) => m.lineId)).size, at(seed)).toBe(matches.length);
      expect(new Set(matches.map((m) => m.recordKey)).size, at(seed)).toBe(matches.length);
      for (const match of matches) {
        const line = lines.get(match.lineId);
        const record = records.get(match.recordKey);
        if (!line || !record) throw new Error(`${at(seed)}: an unknown pair`);
        expect(Math.sign(line.amountPaise), at(seed)).toBe(Math.sign(record.amountPaise));
        expect(['opening', 'payment'], at(seed)).not.toContain(line.kind);
        expect(books.elsewhere.has(match.recordKey), at(seed)).toBe(false);
        expect(rejectedPairs.has(`${match.lineId}>${match.recordKey}`), at(seed)).toBe(false);
        expect(match.differencePaise, at(seed)).toBe(line.amountPaise - record.amountPaise);
        if (match.by === 'amount') {
          expect(Math.abs(match.differencePaise), at(seed)).toBeLessThanOrEqual(
            books.tolerance.amountTolerancePaise,
          );
          const days = Math.abs(Date.parse(line.lineDate) - Date.parse(record.date)) / 86_400_000;
          expect(days, at(seed)).toBeLessThanOrEqual(books.tolerance.dateWindowDays);
        }
      }
    }
  });

  it('explains the whole difference between the brand and us', () => {
    for (const seed of SEEDS) {
      const r = random(seed);
      const books = randomBooks(r);
      const matches = new Map(matchStatement(books).map((match) => [match.lineId, match]));
      const explained = new Set(books.lines.filter(() => r.chance(0.1)).map((line) => line.id));
      const summary = statementSummary(
        books.lines.map((line) => {
          const match = matches.get(line.id);
          const settlement = explained.has(line.id)
            ? { explained: true, differencePaise: null }
            : match
              ? { explained: false, differencePaise: match.differencePaise }
              : null;
          return {
            kind: line.kind,
            amountPaise: line.amountPaise,
            status: lineStatus(line, settlement, books.tolerance),
            differencePaise: settlement?.explained ? null : (settlement?.differencePaise ?? null),
          };
        }),
        books.records.map((record) => ({
          amountPaise: record.amountPaise,
          inPeriod: record.date >= day(0) && record.date <= day(29),
          matched: [...matches.values()].some(
            (match) => match.recordKey === record.key && !explained.has(match.lineId),
          ),
          elsewhere: books.elsewhere.has(record.key),
        })),
        { openingBalancePaise: null, printedClosingPaise: null },
      );
      expect(
        summary.amountDifferencesPaise +
          summary.unmatchedLinesPaise +
          summary.explainedLinesPaise +
          summary.untrackedLinesPaise -
          summary.ourUnmatchedPaise,
        at(seed),
      ).toBe(summary.differencePaise);
    }
  });
});
