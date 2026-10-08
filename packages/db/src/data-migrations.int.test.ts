import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_GST_STATES, SYSTEM_ROLES } from '@paint/shared';
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
  ['0016_grant_purchasing_permissions', '0015_purchasing', 'purchasing:'],
  ['0020_grant_leads_permissions', '0019_leads', 'leads:'],
  ['0022_grant_projects_permissions', '0021_projects', 'projects:'],
  ['0025_audit_triggers', '0024_audit_log', 'audit:'],
  ['0031_grant_contracts_permissions', '0030_contracts', 'contracts:'],
  ['0034_grant_credit_permissions', '0033_credit', 'credit:'],
  ['0037_grant_loyalty_permissions', '0036_loyalty', 'loyalty:'],
  ['0053_grant_tax_permissions', '0052_gst_master_rules', 'tax:'],
  ['0056_grant_billing_permissions', '0055_tax_document_rules', 'sales:'],
  ['0056_grant_billing_permissions', '0055_tax_document_rules', 'billing:'],
])('%s', (_migration, before, prefix) => {
  it("gives existing organisations' standard roles exactly the permissions new ones get", async () => {
    const permissions = await permissionsAfterBackfill(before, prefix);

    expect(permissions).toEqual(expectedGrants(prefix));
    expect(permissions.some((row) => row.key === 'custom')).toBe(false);
  });
});

describe('0048_organization_slug_and_logo', () => {
  it('gives every existing business a unique slug from its name, oldest first', async () => {
    const { connectionString: url } = await freshDatabase();
    await migrateDatabase(url, migrationsUpTo('0047_list_indexes'));
    await withPgClient(url, (client) =>
      client.query(
        `INSERT INTO organizations (name, created_at) VALUES
           ('Sharma Paints', now() - interval '3 days'),
           ('sharma  paints!', now() - interval '2 days'),
           ('Admin', now() - interval '1 day'),
           ('हिंदी पेंट्स', now())`,
      ),
    );

    await migrateDatabase(url);

    const slugs = await withPgClient(url, async (client) => {
      const result = await client.query<{ name: string; slug: string }>(
        'SELECT name, slug FROM organizations ORDER BY created_at',
      );
      return result.rows;
    });
    expect(slugs).toEqual([
      { name: 'Sharma Paints', slug: 'sharma-paints' },
      { name: 'sharma  paints!', slug: 'sharma-paints-2' },
      { name: 'Admin', slug: 'admin-2' },
      { name: 'हिंदी पेंट्स', slug: 'business' },
    ]);
  });
});

describe('0052_gst_master_rules', () => {
  /** Migrates to 0049, runs `setUp` as the previous release would have, then migrates the rest. */
  async function backfilled(
    setUp: (query: (text: string, values?: unknown[]) => Promise<string>) => Promise<void>,
  ): Promise<string> {
    const { connectionString: url } = await freshDatabase();
    await migrateDatabase(url, migrationsUpTo('0049_newest_first_indexes'));
    await withPgClient(url, (client) =>
      setUp(async (text, values) => {
        const result = await client.query<{ id: string }>(text, values);
        return String(result.rows[0]?.id);
      }),
    );
    await migrateDatabase(url);
    return url;
  }

  it('gives every existing product the tax category of its catalogue category, keeping its rate', async () => {
    const url = await backfilled(async (query) => {
      const org = await query(
        "INSERT INTO organizations (name) VALUES ('Old Paints') RETURNING id",
      );
      const brand = await query(
        "INSERT INTO brands (organization_id, name) VALUES ($1, 'Asian') RETURNING id",
        [org],
      );
      const tools = await query(
        "INSERT INTO categories (organization_id, name) VALUES ($1, 'Tools') RETURNING id",
        [org],
      );
      const brushes = await query(
        "INSERT INTO categories (organization_id, name, parent_id) VALUES ($1, 'Brushes', $2) RETURNING id",
        [org, tools],
      );
      const named = async (name: string) =>
        query('INSERT INTO categories (organization_id, name) VALUES ($1, $2) RETURNING id', [
          org,
          name,
        ]);
      const product = (name: string, type: string, rateBps: number, categoryId: string | null) =>
        query(
          `INSERT INTO products (organization_id, brand_id, category_id, name, type, hsn_code, gst_rate_bps)
           VALUES ($1, $2, $3, $4, $5, '3209', $6) RETURNING id`,
          [org, brand, categoryId, name, type, rateBps],
        );
      await product('Wall Putty', 'putty', 1800, await named('Wall Putty'));
      await product('Melamyne', 'wood_finish', 1800, await named('Wood Finish'));
      await product('Flat Brush', 'tool', 1800, brushes);
      await product('Scraper', 'other', 1800, tools);
      await product('Apex', 'exterior_paint', 1800, await named('Exterior Emulsion'));
      await product('Mystery', 'other', 1800, await named('Misc'));
      await product('Sealer', 'putty', 1800, null);
      await product('Free Sample', 'other', 0, null);
      await product('Old Stock', 'interior_paint', 2800, null);
    });

    const rows = await withPgClient(url, async (client) => {
      const result = await client.query<{ product: string; category: string; rate: number }>(
        `SELECT p.name AS product, tc.name AS category, tr.rate_bps AS rate
         FROM products p
         JOIN tax_categories tc ON tc.id = p.tax_category_id
         JOIN tax_rates tr ON tr.tax_category_id = tc.id AND tr.effective_to IS NULL
         ORDER BY p.name`,
      );
      return result.rows;
    });
    expect(rows).toEqual([
      { product: 'Apex', category: 'Paints 18%', rate: 1800 },
      { product: 'Flat Brush', category: 'Brushes & rollers 18%', rate: 1800 },
      { product: 'Free Sample', category: 'Exempt', rate: 0 },
      { product: 'Melamyne', category: 'Varnishes & wood finishes 18%', rate: 1800 },
      { product: 'Mystery', category: 'Paints 18%', rate: 1800 },
      { product: 'Old Stock', category: 'GST 28%', rate: 2800 },
      { product: 'Scraper', category: 'Tools 18%', rate: 1800 },
      { product: 'Sealer', category: 'Putty & fillers 18%', rate: 1800 },
      { product: 'Wall Putty', category: 'Putty & fillers 18%', rate: 1800 },
    ]);
  });

  it("fills parties' place of supply from the GSTIN or the state's name, and stores' state codes", async () => {
    const url = await backfilled(async (query) => {
      const org = await query(
        "INSERT INTO organizations (name) VALUES ('Old Paints') RETURNING id",
      );
      await query(
        "INSERT INTO parties (organization_id, display_name, gstin, state) VALUES ($1, 'With GSTIN', '37AABCS1429B1ZT', 'Telangana')",
        [org],
      );
      for (const [index, state] of CURRENT_GST_STATES.entries()) {
        await query(
          'INSERT INTO parties (organization_id, display_name, state) VALUES ($1, $2, $3)',
          [org, `Party ${String(index)}`, ` ${state.name.toUpperCase()} `],
        );
      }
      await query(
        "INSERT INTO parties (organization_id, display_name, state) VALUES ($1, 'Unknown', 'Atlantis')",
        [org],
      );
      await query(
        "INSERT INTO stores (organization_id, name, code, gstin) VALUES ($1, 'HYD', 'HYD', '36AABCS1429B1ZV')",
        [org],
      );
    });

    const found = await withPgClient(url, async (client) => {
      const partyRows = await client.query<{ name: string; code: string | null }>(
        'SELECT display_name AS name, place_of_supply AS code FROM parties',
      );
      const storeRows = await client.query<{ code: string; type: string }>(
        'SELECT gst_state_code AS code, gst_registration_type AS type FROM stores',
      );
      return { parties: partyRows.rows, stores: storeRows.rows };
    });
    const byName = new Map(found.parties.map((row) => [row.name, row.code]));
    expect(byName.get('With GSTIN')).toBe('37');
    expect(byName.get('Unknown')).toBeNull();
    expect(CURRENT_GST_STATES.map((_, index) => byName.get(`Party ${String(index)}`))).toEqual(
      CURRENT_GST_STATES.map((state) => state.code),
    );
    expect(found.stores).toEqual([{ code: '36', type: 'unregistered' }]);
  });
});
