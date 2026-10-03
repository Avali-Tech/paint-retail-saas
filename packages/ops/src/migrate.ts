import { readdir } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export interface MigrationResult {
  /** Migration files in the folder. */
  readonly available: number;
  /** Migrations recorded in the database afterwards. */
  readonly applied: number;
  /**
   * Whether the connected user may `SET ROLE app_tenant`, which every tenant query
   * does. A superuser always may. On Amazon RDS the master user is not a superuser:
   * creating app_tenant gives it only ADMIN OPTION (PostgreSQL 16+), so the task
   * grants the role to itself once (see grantedTenantRole).
   */
  readonly canUseTenantRole: boolean;
  /** True when this run granted app_tenant to the connected user. */
  readonly grantedTenantRole: boolean;
}

const CAN_SET_TENANT_ROLE = "SELECT pg_has_role(current_user, 'app_tenant', 'SET') AS can";

async function canSetTenantRole(pool: pg.Pool): Promise<boolean> {
  const result = await pool.query(CAN_SET_TENANT_ROLE);
  const [row] = result.rows as [{ can: boolean }];
  return row.can;
}

/** Grants app_tenant to the connected user if it may (ADMIN OPTION); false if refused. */
async function grantTenantRoleToSelf(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('GRANT app_tenant TO CURRENT_USER');
  } catch {
    return false;
  }
  return canSetTenantRole(pool);
}

/**
 * Applies pending migrations, the same way the API does with RUN_MIGRATIONS=true
 * (@paint/db's migrateDatabase). Deploys run this once, as a one-off task, before
 * new API tasks start, so several tasks never migrate at the same time.
 */
export async function runMigrations(
  databaseUrl: string,
  migrationsFolder: string,
): Promise<MigrationResult> {
  const files = await readdir(migrationsFolder);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder });
    const result = await pool.query<{ applied: number }>(
      'SELECT count(*)::int AS applied FROM drizzle.__drizzle_migrations',
    );
    const [row] = result.rows as [{ applied: number }];
    const couldUseTenantRole = await canSetTenantRole(pool);
    const grantedTenantRole = !couldUseTenantRole && (await grantTenantRoleToSelf(pool));
    return {
      available: files.filter((file) => file.endsWith('.sql')).length,
      applied: row.applied,
      canUseTenantRole: couldUseTenantRole || grantedTenantRole,
      grantedTenantRole,
    };
  } finally {
    await pool.end();
  }
}

/** Problems that must stop a deploy; empty when the database is ready for this release. */
export function migrationProblems(result: MigrationResult): string[] {
  const problems: string[] = [];
  if (result.applied > result.available) {
    problems.push(
      `the database has ${String(result.applied)} migrations but this release ships ${String(result.available)}: it is older than the database`,
    );
  }
  if (!result.canUseTenantRole) {
    problems.push(
      'the database user cannot SET ROLE app_tenant and may not grant it to itself; as a user with ADMIN OPTION on app_tenant, run: GRANT app_tenant TO <database user>',
    );
  }
  return problems;
}
