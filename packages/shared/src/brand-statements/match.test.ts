import { describe, expect, it } from 'vitest';
import {
  lineStatus,
  matchStatement,
  statementSummary,
  unmatchable,
  type MatchInput,
  type MatchLine,
  type MatchRecord,
} from './match.js';

const tolerance = { dateWindowDays: 7, amountTolerancePaise: 100 };

const line = (id: string, values: Partial<MatchLine> = {}): MatchLine => ({
  id,
  rowNumber: Number(id.replace(/\D/g, '')) || 1,
  lineDate: '2026-09-05',
  kind: 'invoice',
  documentNumber: null,
  reference: null,
  amountPaise: 118_000,
  ...values,
});

const record = (key: string, values: Partial<MatchRecord> = {}): MatchRecord => ({
  key,
  date: '2026-09-05',
  references: [],
  amountPaise: 118_000,
  ...values,
});

const input = (values: Partial<MatchInput>): MatchInput => ({
  lines: [],
  records: [],
  fixed: [],
  rejected: [],
  elsewhere: new Set(),
  tolerance,
  ...values,
});

describe('matchStatement', () => {
  it('matches by reference first, whatever the amount, then by date window and amount', () => {
    const matches = matchStatement(
      input({
        lines: [
          line('l1', { documentNumber: 'INV/0881', amountPaise: 120_000 }),
          line('l2', { lineDate: '2026-09-10', amountPaise: 50_000 }),
          line('l3', { kind: 'other', amountPaise: -5_000, reference: 'cn 77' }),
        ],
        records: [
          record('grn:a', { amountPaise: 50_050, date: '2026-09-14' }),
          record('grn:b', { references: ['inv-0881'] }),
          record('benefit_receipt:c', { amountPaise: -5_000, references: ['CN77'] }),
        ],
      }),
    );
    expect(matches).toEqual([
      { lineId: 'l1', recordKey: 'grn:b', differencePaise: 2_000, by: 'reference' },
      { lineId: 'l2', recordKey: 'grn:a', differencePaise: -50, by: 'amount' },
      { lineId: 'l3', recordKey: 'benefit_receipt:c', differencePaise: 0, by: 'reference' },
    ]);
  });

  it('keeps to the window, the tolerance and the sign', () => {
    const matches = matchStatement(
      input({
        lines: [line('l1'), line('l2', { amountPaise: -118_000, kind: 'other' })],
        records: [
          record('grn:late', { date: '2026-09-13' }),
          record('grn:off', { amountPaise: 118_101 }),
        ],
      }),
    );
    expect(matches).toEqual([]);
    expect(
      matchStatement(
        input({ lines: [line('l1')], records: [record('grn:edge', { date: '2026-09-12' })] }),
      ),
    ).toHaveLength(1);
  });

  it('picks the closest amount, then the closest date, then the key, each record once', () => {
    const matches = matchStatement(
      input({
        lines: [line('l1'), line('l2'), line('l3')],
        records: [
          record('grn:z', { date: '2026-09-07', amountPaise: 118_000 }),
          record('grn:y', { date: '2026-09-06', amountPaise: 118_000 }),
          record('grn:x', { date: '2026-09-05', amountPaise: 118_050 }),
        ],
      }),
    );
    expect(matches.map((match) => [match.lineId, match.recordKey])).toEqual([
      ['l1', 'grn:y'],
      ['l2', 'grn:z'],
      ['l3', 'grn:x'],
    ]);
    const tie = matchStatement(
      input({ lines: [line('l1')], records: [record('grn:b'), record('grn:a')] }),
    );
    expect(tie[0]?.recordKey).toBe('grn:a');
  });

  it('leaves fixed lines, their records, rejected pairs, other statements and payments alone', () => {
    const matches = matchStatement(
      input({
        lines: [
          line('l1'),
          line('l2'),
          line('l3', { kind: 'payment', amountPaise: -118_000 }),
          line('l4', { kind: 'opening' }),
          line('l5'),
        ],
        records: [record('grn:a'), record('grn:b'), record('grn:c'), record('grn:d')],
        fixed: [
          { lineId: 'l1', recordKey: 'grn:a' },
          { lineId: 'l5', recordKey: null },
        ],
        rejected: [{ lineId: 'l2', recordKey: 'grn:b' }],
        elsewhere: new Set(['grn:c']),
      }),
    );
    expect(matches).toEqual([
      { lineId: 'l2', recordKey: 'grn:d', differencePaise: 0, by: 'amount' },
    ]);
    expect(unmatchable('payment')).toBe(true);
    expect(unmatchable('credit_note')).toBe(false);
  });
});

describe('lineStatus', () => {
  it('is explained, matched within the tolerance, partial beyond it, else unmatched or untracked', () => {
    expect(
      lineStatus({ kind: 'invoice' }, { explained: true, differencePaise: null }, tolerance),
    ).toBe('explained');
    expect(
      lineStatus({ kind: 'invoice' }, { explained: false, differencePaise: -100 }, tolerance),
    ).toBe('matched');
    expect(
      lineStatus({ kind: 'invoice' }, { explained: false, differencePaise: 101 }, tolerance),
    ).toBe('partial');
    expect(lineStatus({ kind: 'invoice' }, null, tolerance)).toBe('unmatched');
    expect(lineStatus({ kind: 'payment' }, null, tolerance)).toBe('untracked');
  });
});

describe('statementSummary', () => {
  it('splits the difference into amount differences, brand-only lines and our-only records', () => {
    const summary = statementSummary(
      [
        { kind: 'opening', amountPaise: 2_500_000, status: 'unmatched', differencePaise: null },
        { kind: 'invoice', amountPaise: 118_000, status: 'matched', differencePaise: 0 },
        { kind: 'invoice', amountPaise: 60_000, status: 'partial', differencePaise: 10_000 },
        { kind: 'invoice', amountPaise: 30_000, status: 'unmatched', differencePaise: null },
        { kind: 'other', amountPaise: -5_000, status: 'explained', differencePaise: null },
        { kind: 'payment', amountPaise: -100_000, status: 'untracked', differencePaise: null },
      ],
      [
        { amountPaise: 118_000, inPeriod: true, matched: true, elsewhere: false },
        { amountPaise: 50_000, inPeriod: false, matched: true, elsewhere: false },
        { amountPaise: 20_000, inPeriod: true, matched: false, elsewhere: false },
        { amountPaise: 9_000, inPeriod: false, matched: false, elsewhere: false },
        { amountPaise: 7_000, inPeriod: true, matched: false, elsewhere: true },
      ],
      { openingBalancePaise: 2_500_000, printedClosingPaise: 2_603_000 },
    );
    expect(summary).toEqual({
      counts: { matched: 1, partial: 1, unmatched: 1, explained: 1, untracked: 1 },
      brandMovementPaise: 103_000,
      ourMovementPaise: 188_000,
      differencePaise: -85_000,
      amountDifferencesPaise: 10_000,
      unmatchedLinesPaise: 30_000,
      explainedLinesPaise: -5_000,
      untrackedLinesPaise: -100_000,
      ourUnmatchedPaise: 20_000,
      ourUnmatchedCount: 1,
      openingBalancePaise: 2_500_000,
      brandClosingPaise: 2_603_000,
      printedClosingPaise: 2_603_000,
    });
    expect(
      summary.amountDifferencesPaise +
        summary.unmatchedLinesPaise +
        summary.explainedLinesPaise +
        summary.untrackedLinesPaise -
        summary.ourUnmatchedPaise,
    ).toBe(summary.differencePaise);
    expect(
      statementSummary([], [], { openingBalancePaise: null, printedClosingPaise: null })
        .brandClosingPaise,
    ).toBeNull();
  });
});
