import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYSTEM_ROLES } from '@paint/shared';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { MIGRATIONS_FOLDER, migrateDatabase } from './index.js';

// Data migrations are tested by migrating to the version before them, adding
// data as the old code would have, then applying the rest.

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A copy of the migrations folder containing only migrations up to and including `lastTag`. */
function migrationsUpTo(lastTag: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'migrations-'));
  cleanups.push(() => {
    rmSync(folder, { recursive: true, force: true });
  });
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (last === -1) throw new Error(`No migration ${lastTag}`);
  journal.entries = journal.entries.slice(0, last + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

async function freshDatabase(): Promise<TestDatabase> {
  const database = await createIsolatedDatabase(inject('databaseUrl'));
  cleanups.push(() => database.stop());
  return database;
}

/**
 * Migrates to `before`, creates an organisation with the standard roles as the
 * old code would have (plus a custom role), applies the rest, and returns the
 * role/permission pairs whose permission starts with `prefix`.
 */
async function permissionsAfterBackfill(before: string, prefix: string) {
  const { connectionString: url } = await freshDatabase();
  await migrateDatabase(url, migrationsUpTo(before));

  await withPgClient(url, async (client) => {
    const org = await client.query<{ id: string }>(
      "INSERT INTO organizations (name) VALUES ('Old Paints') RETURNING id",
    );
    const organizationId = org.rows[0]?.id;
    for (const role of [...SYSTEM_ROLES.map((r) => r.key), 'custom']) {
      const inserted = await client.query<{ id: string }>(
        'INSERT INTO roles (organization_id, key, name, is_system) VALUES ($1, $2, $2, $3) RETURNING id',
        [organizationId, role, role !== 'custom'],
      );
      await client.query(
        "INSERT INTO role_permissions (organization_id, role_id, permission) VALUES ($1, $2, 'stores:read')",
        [organizationId, inserted.rows[0]?.id],
      );
    }
  });

  await migrateDatabase(url);
  await migrateDatabase(url);

  return withPgClient(url, async (client) => {
    const result = await client.query<{ key: string; permission: string }>(
      `SELECT r.key, rp.permission FROM roles r
       JOIN role_permissions rp ON rp.role_id = r.id
       WHERE rp.permission LIKE $1
       ORDER BY r.key, rp.permission`,
      [`${prefix}%`],
    );
    return result.rows;
  });
}

/** What SYSTEM_ROLES grants for permissions starting with `prefix`, in the same order. */
function expectedGrants(prefix: string) {
  return SYSTEM_ROLES.flatMap((role) =>
    role.permissions
      .filter((permission) => permission.startsWith(prefix))
      .map((permission) => ({ key: role.key, permission })),
  ).sort((a, b) => `${a.key}${a.permission}`.localeCompare(`${b.key}${b.permission}`));
}

describe.each([
  ['0005_grant_parties_permissions', '0004_parties', 'parties:'],
  ['0007_grant_catalog_permissions', '0006_catalog', 'catalog:'],
  ['0010_grant_inventory_permissions', '0009_stock_ledger_append_only', 'inventory:'],
])('%s', (_migration, before, prefix) => {
  it("gives existing organisations' standard roles exactly the permissions new ones get", async () => {
    const permissions = await permissionsAfterBackfill(before, prefix);

    expect(permissions).toEqual(expectedGrants(prefix));
    expect(permissions.some((row) => row.key === 'custom')).toBe(false);
  });
});
