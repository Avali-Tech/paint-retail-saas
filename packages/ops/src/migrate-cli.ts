// One-off migration task: `node src/migrate-cli.ts` in the ops image, with
// DATABASE_URL and MIGRATIONS_FOLDER (default ./migrations). Logic: migrate.ts.
import { migrationProblems, runMigrations } from './migrate.ts';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === '') {
  console.error('DATABASE_URL is not set');
  process.exitCode = 2;
} else {
  const result = await runMigrations(databaseUrl, process.env.MIGRATIONS_FOLDER ?? 'migrations');
  console.log(
    `Migrations: ${String(result.applied)} applied, ${String(result.available)} in this release`,
  );
  if (result.grantedTenantRole) console.log('Granted app_tenant to the database user');
  const problems = migrationProblems(result);
  for (const problem of problems) console.error(`PROBLEM: ${problem}`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
