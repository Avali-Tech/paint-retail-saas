import { describe, expect, it } from 'vitest';
import { compareDatabases } from './compare.ts';
import type { DatabaseFacts, TableFacts } from './inspect.ts';

const table = (name: string, overrides: Partial<TableFacts> = {}): TableFacts => ({
  name,
  rows: 3,
  rowLevelSecurity: true,
  forceRowLevelSecurity: false,
  policies: 1,
  ...overrides,
});

const facts = (overrides: Partial<DatabaseFacts> = {}): DatabaseFacts => ({
  migrations: { count: 41, latest: '1767225600000' },
  tables: [
    table('public.organizations'),
    table('drizzle.__drizzle_migrations', { rowLevelSecurity: false, policies: 0 }),
  ],
  grants: ['app_tenant public.organizations SELECT'],
  roles: ['app_tenant'],
  ...overrides,
});

describe('compareDatabases', () => {
  it('passes when the restore matches the source', () => {
    expect(compareDatabases(facts(), facts())).toEqual([]);
  });

  it('reports different migrations, and a source without any', () => {
    expect(compareDatabases(facts(), facts({ migrations: { count: 40, latest: '1' } }))).toEqual([
      'migrations: source has 41 (latest 1767225600000), restored has 40 (latest 1)',
    ]);
    expect(
      compareDatabases(
        facts({ migrations: { count: 0, latest: null } }),
        facts({ migrations: { count: 0, latest: null } }),
      ),
    ).toEqual(['the source has no applied migrations']);
    expect(
      compareDatabases(facts(), facts({ migrations: { count: 41, latest: '2' } })),
    ).toHaveLength(1);
  });

  it('reports missing and extra tables, and differences in rows, RLS and policies', () => {
    const restored = facts({
      tables: [
        table('public.organizations', {
          rows: 2,
          rowLevelSecurity: false,
          forceRowLevelSecurity: true,
          policies: 0,
        }),
        table('public.surprise'),
      ],
    });

    expect(compareDatabases(facts(), restored)).toEqual([
      'table public.organizations: rows is 3 in the source, 2 restored',
      'table public.organizations: rowLevelSecurity is true in the source, false restored',
      'table public.organizations: forceRowLevelSecurity is false in the source, true restored',
      'table public.organizations: policies is 1 in the source, 0 restored',
      'table drizzle.__drizzle_migrations is missing from the restore',
      'table public.surprise exists only in the restore',
      'table public.organizations has row-level security disabled',
    ]);
  });

  it('reports grants that were lost or gained', () => {
    expect(
      compareDatabases(facts(), facts({ grants: ['app_tenant public.organizations INSERT'] })),
    ).toEqual([
      'grant missing from the restore: app_tenant public.organizations SELECT',
      'grant only in the restore: app_tenant public.organizations INSERT',
    ]);
  });
});
