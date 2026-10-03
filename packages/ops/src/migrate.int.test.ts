import { randomUUID } from 'node:crypto';
import { MIGRATIONS_FOLDER } from '@paint/db';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { migrationProblems, runMigrations } from './migrate.ts';

let database: TestDatabase;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
});

afterAll(async () => {
  await database.stop();
});

describe('runMigrations', () => {
  it('applies every migration in the folder, and is safe to run again', async () => {
    const first = await runMigrations(database.connectionString, MIGRATIONS_FOLDER);
    const second = await runMigrations(database.connectionString, MIGRATIONS_FOLDER);

    expect(first.available).toBeGreaterThan(0);
    expect(first).toEqual({
      available: first.available,
      applied: first.available,
      canUseTenantRole: true,
      grantedTenantRole: false,
    });
    expect(second).toEqual(first);
    expect(migrationProblems(first)).toEqual([]);
    const tablesWithoutRls = await withPgClient(database.connectionString, async (client) => {
      const result = await client.query<{ off: number }>(
        `SELECT count(*)::int AS off FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`,
      );
      return result.rows[0]?.off;
    });
    expect(tablesWithoutRls).toBe(0);
  });

  /** Runs migrations as a new non-superuser that owns a fresh database, like an RDS master user. */
  async function migrateAsNonSuperuser(setUp: (user: string) => string) {
    const user = `migrator_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const other = await createIsolatedDatabase(inject('databaseUrl'));
    try {
      await withPgClient(inject('databaseUrl'), async (client) => {
        await client.query(`CREATE ROLE ${user} LOGIN PASSWORD 'pw' CREATEROLE`);
        await client.query(
          `ALTER DATABASE ${new URL(other.connectionString).pathname.slice(1)} OWNER TO ${user}`,
        );
        const extra = setUp(user);
        if (extra) await client.query(extra);
      });
      const url = new URL(other.connectionString);
      url.username = user;
      url.password = 'pw';
      return await runMigrations(url.toString(), MIGRATIONS_FOLDER);
    } finally {
      await other.stop();
      await withPgClient(inject('databaseUrl'), (client) =>
        client.query(`DROP OWNED BY ${user}; DROP ROLE ${user}`),
      );
    }
  }

  it('grants itself the tenant role when it holds ADMIN OPTION, as an RDS master user that created it does', async () => {
    // PostgreSQL 16+ gives the creator of a role ADMIN OPTION only (no SET, no INHERIT).
    const result = await migrateAsNonSuperuser(
      (user) => `GRANT app_tenant TO ${user} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`,
    );

    expect(result.grantedTenantRole).toBe(true);
    expect(result.canUseTenantRole).toBe(true);
    expect(migrationProblems(result)).toEqual([]);
  });

  it('reports when the user can neither switch to nor grant the tenant role', async () => {
    const result = await migrateAsNonSuperuser(() => '');

    expect(result.canUseTenantRole).toBe(false);
    expect(result.grantedTenantRole).toBe(false);
    expect(migrationProblems(result)).toEqual([
      'the database user cannot SET ROLE app_tenant and may not grant it to itself; as a user with ADMIN OPTION on app_tenant, run: GRANT app_tenant TO <database user>',
    ]);
  });

  it('fails when the folder does not exist', async () => {
    await expect(runMigrations(database.connectionString, '/no/such/folder')).rejects.toThrow(
      /ENOENT/,
    );
  });
});

describe('migrationProblems', () => {
  it('stops a release that is older than the database', () => {
    expect(
      migrationProblems({
        available: 40,
        applied: 41,
        canUseTenantRole: true,
        grantedTenantRole: false,
      }),
    ).toEqual([
      'the database has 41 migrations but this release ships 40: it is older than the database',
    ]);
  });
});
