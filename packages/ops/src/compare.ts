import type { DatabaseFacts, TableFacts } from './inspect.ts';

const difference = (left: readonly string[], right: readonly string[]) =>
  left.filter((item) => !right.includes(item));

/**
 * Everything that differs between the source database and its restored copy, plus
 * anything unsafe in the copy (a tenant table without row-level security). Empty = passed.
 */
export function compareDatabases(source: DatabaseFacts, restored: DatabaseFacts): string[] {
  const problems: string[] = [];

  if (source.migrations.count === 0) problems.push('the source has no applied migrations');
  if (
    source.migrations.count !== restored.migrations.count ||
    source.migrations.latest !== restored.migrations.latest
  ) {
    problems.push(
      `migrations: source has ${String(source.migrations.count)} (latest ${String(source.migrations.latest)}), ` +
        `restored has ${String(restored.migrations.count)} (latest ${String(restored.migrations.latest)})`,
    );
  }

  const restoredTables = new Map(restored.tables.map((table) => [table.name, table]));
  for (const table of source.tables) {
    const copy = restoredTables.get(table.name);
    if (!copy) {
      problems.push(`table ${table.name} is missing from the restore`);
      continue;
    }
    for (const field of [
      'rows',
      'rowLevelSecurity',
      'forceRowLevelSecurity',
      'policies',
    ] as const) {
      if (table[field] !== copy[field]) {
        problems.push(
          `table ${table.name}: ${field} is ${String(table[field])} in the source, ${String(copy[field])} restored`,
        );
      }
    }
  }
  const sourceNames = source.tables.map((table) => table.name);
  for (const extra of difference([...restoredTables.keys()], sourceNames)) {
    problems.push(`table ${extra} exists only in the restore`);
  }

  for (const table of restored.tables.filter(isTenantTableWithoutRls)) {
    problems.push(`table ${table.name} has row-level security disabled`);
  }

  for (const grant of difference(source.grants, restored.grants)) {
    problems.push(`grant missing from the restore: ${grant}`);
  }
  for (const grant of difference(restored.grants, source.grants)) {
    problems.push(`grant only in the restore: ${grant}`);
  }
  return problems;
}

/** Every table in the public schema holds tenant data and must have RLS on. */
function isTenantTableWithoutRls(table: TableFacts): boolean {
  return table.name.startsWith('public.') && !table.rowLevelSecurity;
}
