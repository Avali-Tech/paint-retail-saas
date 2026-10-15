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
      'accounting_exports',
      'activities',
      'allocations',
      'audit_log',
      'brands',
      'categories',
      'contracts',
      'credit_profiles',
      'credit_requests',
      'credit_rules',
      'customer_profiles',
      'dispatch_lines',
      'dispatches',
      'document_sequences',
      'document_series',
      'documents',
      'email_outbox',
      'estimate_options',
      'estimate_surfaces',
      'estimates',
      'go_live_openings',
      'goods_receipt_lines',
      'goods_receipts',
      'gstin_profiles',
      'idempotency_keys',
      'leads',
      'ledger_mappings',
      'low_stock_alerts',
      'loyalty_accounts',
      'loyalty_ledger',
      'loyalty_settings',
      'member_stores',
      'notification_preferences',
      'notifications',
      'opportunities',
      'organization_branding',
      'organization_logos',
      'organization_members',
      'organizations',
      'otp_challenges',
      'parties',
      'party_balances',
      'party_ledger',
      'party_roles',
      'payment_gateway_events',
      'payment_modes',
      'payments',
      'platform_admins',
      'platform_sessions',
      'product_barcodes',
      'product_variants',
      'products',
      'project_parties',
      'projects',
      'purchase_order_lines',
      'purchase_orders',
      'quotation_lines',
      'quotations',
      'reconciliation_findings',
      'reconciliation_runs',
      'register_cash_movements',
      'register_sessions',
      'reorder_rules',
      'role_permissions',
      'roles',
      'sales_order_lines',
      'sales_orders',
      'sales_return_lines',
      'sales_returns',
      'sales_settings',
      'sessions',
      'stock_balances',
      'stock_count_lines',
      'stock_counts',
      'stock_ledger',
      'stock_reservations',
      'stores',
      'subscription_checkouts',
      'subscription_invoice_sequences',
      'subscription_invoices',
      'subscription_plan_changes',
      'subscriptions',
      'supplier_products',
      'supplier_profiles',
      'support_access_log',
      'support_grants',
      'tax_categories',
      'tax_document_lines',
      'tax_document_links',
      'tax_document_tax_rows',
      'tax_documents',
      'tax_rates',
      'tint_records',
      'transfer_lines',
      'transfers',
      'two_factor_challenges',
      'user_recovery_codes',
      'user_totp',
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
    ).toEqual([
      'otp_challenges',
      'payment_gateway_events',
      'platform_admins',
      'platform_sessions',
      'subscription_invoice_sequences',
      'two_factor_challenges',
      'user_recovery_codes',
      'user_totp',
    ]);
  });

  it.each([
    {
      list: 'stock movements',
      index: 'stock_ledger_organization_created_idx',
      query: `SELECT id FROM stock_ledger
              WHERE organization_id = '00000000-0000-0000-0000-000000000001'
              ORDER BY created_at DESC, id DESC LIMIT 50`,
    },
    {
      list: 'documents',
      index: 'documents_recent_idx',
      query: `SELECT id FROM documents
              WHERE organization_id = '00000000-0000-0000-0000-000000000001' AND deleted_at IS NULL
              ORDER BY created_at DESC, id DESC LIMIT 50`,
    },
  ])(
    'lists a business’s newest $list straight from $index, with no sort',
    async ({ index, query }) => {
      const url = await freshDatabase();
      await migrateDatabase(url);

      const plan = await withPgClient(url, async (client) => {
        // An empty table would otherwise get a sequential or bitmap scan plus a sort.
        await client.query('SET enable_seqscan = off');
        await client.query('SET enable_bitmapscan = off');
        const result = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${query}`);
        return result.rows.map((row) => row['QUERY PLAN']).join('\n');
      });

      expect(plan).toContain(index);
      expect(plan).not.toContain('Sort');
    },
  );
});
