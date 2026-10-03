import type pg from 'pg';

export interface TableFacts {
  /** schema.table */
  readonly name: string;
  readonly rows: number;
  readonly rowLevelSecurity: boolean;
  readonly forceRowLevelSecurity: boolean;
  readonly policies: number;
}

/** What a restore must reproduce: applied migrations, tables, rows, RLS and grants. */
export interface DatabaseFacts {
  readonly migrations: { readonly count: number; readonly latest: string | null };
  readonly tables: readonly TableFacts[];
  /** "role schema.table PRIVILEGE" for every grant to a role other than the table's owner. */
  readonly grants: readonly string[];
  /** Roles named in grants and policies; they live outside the database and must exist. */
  readonly roles: readonly string[];
}

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

const USER_TABLES = `
  SELECT n.nspname AS schema, c.relname AS name,
         c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
         (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%'
  ORDER BY 1, 2`;

const GRANTS = `
  SELECT DISTINCT format('%s %s.%s %s', pg_get_userbyid(a.grantee), n.nspname, c.relname,
                         a.privilege_type) AS grant
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.relkind IN ('r', 'p') AND a.grantee <> 0 AND a.grantee <> c.relowner
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY 1`;

const ROLES = `
  SELECT DISTINCT pg_get_userbyid(r) AS role FROM (
    SELECT unnest(polroles) AS r FROM pg_policy
    UNION
    SELECT (aclexplode(c.relacl)).grantee FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  ) roles
  WHERE r <> 0 AND r <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
  ORDER BY 1`;

/**
 * Reads the facts of the database `client` is connected to. Counts every row:
 * row_security is off, so PostgreSQL raises an error rather than silently hiding
 * rows from a role that row-level security would filter.
 */
export async function inspectDatabase(client: pg.ClientBase): Promise<DatabaseFacts> {
  await client.query('SET row_security = off');
  const hasMigrations = await client.query<{ present: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present",
  );
  const [{ present }] = hasMigrations.rows as [{ present: boolean }];
  const migrations = present
    ? ((
        await client.query(
          'SELECT count(*)::int AS count, max(created_at)::text AS latest FROM drizzle.__drizzle_migrations',
        )
      ).rows[0] as DatabaseFacts['migrations'])
    : { count: 0, latest: null };

  const tableRows = await client.query<{
    schema: string;
    name: string;
    rls: boolean;
    force_rls: boolean;
    policies: number;
  }>(USER_TABLES);
  const tables: TableFacts[] = [];
  for (const table of tableRows.rows) {
    const counted = await client.query(
      `SELECT count(*)::int AS rows FROM ${quoteIdent(table.schema)}.${quoteIdent(table.name)}`,
    );
    const [{ rows }] = counted.rows as [{ rows: number }];
    tables.push({
      name: `${table.schema}.${table.name}`,
      rows,
      rowLevelSecurity: table.rls,
      forceRowLevelSecurity: table.force_rls,
      policies: table.policies,
    });
  }

  const grants = await client.query<{ grant: string }>(GRANTS);
  const roles = await client.query<{ role: string }>(ROLES);
  return {
    migrations,
    tables,
    grants: grants.rows.map((row) => row.grant),
    roles: roles.rows.map((row) => row.role),
  };
}
