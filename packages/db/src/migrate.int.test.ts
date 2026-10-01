import { existsSync, readdirSync } from 'node:fs';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { MIGRATIONS_FOLDER, migrateDatabase } from './index.js';

const databases: TestDatabase[] = [];

async function freshDatabase(): Promise<string> {
  const database = await createIsolatedDatabase(inject('databaseUrl'));
  databases.push(database);
  return database.connectionString;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.stop()));
});

describe('migrateDatabase', () => {
  it('creates the tables, the tenant role and the migration history on an empty database', async () => {
    const url = await freshDatabase();

    await migrateDatabase(url);

    const tables = await withPgClient(url, async (client) => {
      const result = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      );
      return result.rows.map((row) => row.table_name);
    });
    expect(tables).toEqual([
      'activities',
      'audit_log',
      'brands',
      'categories',
      'customer_profiles',
      'document_sequences',
      'documents',
      'email_outbox',
      'goods_receipt_lines',
      'goods_receipts',
      'leads',
      'low_stock_alerts',
      'member_stores',
      'notification_preferences',
      'notifications',
      'opportunities',
      'organization_members',
      'organizations',
      'otp_challenges',
      'parties',
      'party_roles',
      'platform_admins',
      'platform_sessions',
      'product_barcodes',
      'product_variants',
      'products',
      'project_parties',
      'projects',
      'purchase_order_lines',
      'purchase_orders',
      'reorder_rules',
      'role_permissions',
      'roles',
      'sessions',
      'stock_balances',
      'stock_count_lines',
      'stock_counts',
      'stock_ledger',
      'stores',
      'supplier_products',
      'supplier_profiles',
      'support_access_log',
      'support_grants',
      'transfer_lines',
      'transfers',
      'users',
    ]);

    const roleCanLogIn = await withPgClient(url, async (client) => {
      const result = await client.query<{ rolcanlogin: boolean }>(
        "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'app_tenant'",
      );
      return result.rows[0]?.rolcanlogin;
    });
    expect(roleCanLogIn).toBe(false);
  });

  it('skips migrations that have already run', async () => {
    const url = await freshDatabase();

    await migrateDatabase(url);
    await migrateDatabase(url);

    const applied = await withPgClient(url, async (client) => {
      const result = await client.query('SELECT 1 FROM drizzle.__drizzle_migrations');
      return result.rowCount;
    });
    expect(applied).toBe(readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith('.sql')).length);
  });

  it('works on a second database on the same server, where the role already exists', async () => {
    await migrateDatabase(await freshDatabase());

    await expect(migrateDatabase(await freshDatabase())).resolves.toBeUndefined();
  });

  it('survives several databases on one server migrating at the same moment', async () => {
    const urls = await Promise.all(Array.from({ length: 5 }, () => freshDatabase()));

    await expect(Promise.all(urls.map((url) => migrateDatabase(url)))).resolves.toHaveLength(5);
  });

  it('fails clearly when the database cannot be reached', async () => {
    await expect(migrateDatabase('postgres://nobody:wrong@127.0.0.1:1/none')).rejects.toThrow();
  });

  it('points at the migrations folder shipped with the package', () => {
    expect(existsSync(MIGRATIONS_FOLDER)).toBe(true);
  });

  // Guard for every future migration: a table without row-level security would
  // let one organisation read another organisation's rows.
  it('enables row-level security on every table', async () => {
    const url = await freshDatabase();
    await migrateDatabase(url);

    const tables = await withPgClient(url, async (client) => {
      const result = await client.query<{
        table_name: string;
        rls: boolean;
        policies: number;
      }>(`
        SELECT c.relname AS table_name,
               c.relrowsecurity AS rls,
               (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
      `);
      return result.rows;
    });

    expect(tables.filter((t) => !t.rls).map((t) => t.table_name)).toEqual([]);
    // With RLS on and no policy, the tenant role sees nothing: correct only for
    // tables that are used exclusively outside tenant scope.
    expect(
      tables
        .filter((t) => t.policies === 0)
        .map((t) => t.table_name)
        .sort(),
    ).toEqual(['otp_challenges', 'platform_admins', 'platform_sessions']);
  });
});
