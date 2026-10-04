import { describe, expect, it } from 'vitest';
import type { DatabaseFacts } from './inspect.ts';
import { drillDatabaseName, formatReport, type RestoreDrillReport } from './restore-drill.ts';

const facts: DatabaseFacts = {
  migrations: { count: 41, latest: '1767225600000' },
  tables: [
    {
      name: 'public.a',
      rows: 2,
      rowLevelSecurity: true,
      forceRowLevelSecurity: false,
      policies: 1,
    },
    {
      name: 'public.b',
      rows: 5,
      rowLevelSecurity: true,
      forceRowLevelSecurity: false,
      policies: 1,
    },
  ],
  grants: [],
  roles: [],
};

const report = (overrides: Partial<RestoreDrillReport> = {}): RestoreDrillReport => ({
  ok: true,
  problems: [],
  restoredDatabase: 'restore_drill_20261002_143000',
  kept: false,
  dumpBytes: 2048,
  source: facts,
  restored: facts,
  durationMs: 12_400,
  ...overrides,
});

describe('drillDatabaseName', () => {
  it('names the database after the time the drill started (UTC)', () => {
    expect(drillDatabaseName(new Date('2026-10-02T14:30:00.123Z'))).toBe(
      'restore_drill_20261002_143000',
    );
  });
});

describe('formatReport', () => {
  it('summarises a passed drill', () => {
    expect(formatReport(report())).toBe(
      [
        'RESTORE DRILL PASSED',
        '  migrations: 41 (latest 1767225600000)',
        '  tables: 2, rows: 7, dump: 2048 bytes',
        '  restored into: restore_drill_20261002_143000 (dropped)',
        '  took: 12 s',
      ].join('\n'),
    );
  });

  it('lists the problems of a failed drill', () => {
    const text = formatReport(report({ ok: false, kept: true, problems: ['table x is missing'] }));

    expect(text).toMatch(/^RESTORE DRILL FAILED/);
    expect(text).toContain('(kept)');
    expect(text).toContain('  PROBLEM: table x is missing');
  });
});
