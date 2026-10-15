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
  ['0059_grant_payment_permissions', '0058_payment_rules', 'payments:'],
  ['0059_grant_payment_permissions', '0058_payment_rules', 'register:'],
  ['0059_grant_payment_permissions', '0058_payment_rules', 'billing:notes'],
  ['0059_grant_payment_permissions', '0058_payment_rules', 'accounting:'],
  ['0062_grant_order_permissions', '0061_order_rules', 'sales:manage'],
  ['0071_grant_credit_approve_sale', '0070_credit_enforcement_rules', 'credit:approve_sale'],
  ['0076_grant_receivables_read', '0075_collections_and_messaging_rules', 'receivables:'],
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

describe('0068_backfills: tax nature', () => {
  it('records the nature of every issued line from its category, and keeps issued lines unchangeable', async () => {
    const { connectionString: url } = await freshDatabase();
    await migrateDatabase(url, migrationsUpTo('0067_print_settings'));
    const ids = await withPgClient(url, async (client) => {
      const one = async (text: string, values: unknown[] = []) => {
        const result = await client.query<{ id: string }>(text, values);
        return String(result.rows[0]?.id);
      };
      const org = await one("INSERT INTO organizations (name) VALUES ('Old Paints') RETURNING id");
      const category = (key: string) =>
        one('SELECT id FROM tax_categories WHERE organization_id = $1 AND key = $2', [org, key]);
      const paints = await category('paints');
      const exempt = await category('exempt');
      const nil = await one(
        "INSERT INTO tax_categories (organization_id, name) VALUES ($1, 'Nil rated') RETURNING id",
        [org],
      );
      const store = await one(
        "INSERT INTO stores (organization_id, name, code) VALUES ($1, 'Ameerpet', 'AMP') RETURNING id",
        [org],
      );
      const role = await one(
        "INSERT INTO roles (organization_id, key, name) VALUES ($1, 'x', 'X') RETURNING id",
        [org],
      );
      const user = await one(
        "INSERT INTO users (full_name, email) VALUES ('Ravi', 'ravi-0068@example.com') RETURNING id",
      );
      const member = await one(
        'INSERT INTO organization_members (organization_id, user_id, role_id) VALUES ($1, $2, $3) RETURNING id',
        [org, user, role],
      );
      const brand = await one(
        "INSERT INTO brands (organization_id, name) VALUES ($1, 'Asian') RETURNING id",
        [org],
      );
      const product = await one(
        `INSERT INTO products (organization_id, brand_id, name, type, hsn_code, gst_rate_bps)
         VALUES ($1, $2, 'Apex', 'exterior_paint', '32091090', 1800) RETURNING id`,
        [org, brand],
      );
      const variant = await one(
        `INSERT INTO product_variants (organization_id, product_id, sku, pack_size, unit)
         VALUES ($1, $2, 'AP-1L', 1, 'l') RETURNING id`,
        [org, product],
      );
      const series = await one(
        `INSERT INTO document_series (organization_id, store_id, kind, prefix, digits)
         VALUES ($1, $2, 'invoice', 'AMP', 6) RETURNING id`,
        [org, store],
      );
      const document = () =>
        one(
          `INSERT INTO tax_documents (organization_id, kind, store_id, created_by_member_id)
           VALUES ($1, 'invoice', $2, $3) RETURNING id`,
          [org, store, member],
        );
      const issued = await document();
      const draft = await document();
      const line = (doc: string, lineNo: number, categoryId: string | null, rate: number | null) =>
        one(
          `INSERT INTO tax_document_lines
             (organization_id, document_id, line_no, variant_id, quantity, unit_price_paise,
              taxable_paise, total_paise, tax_category_id, rate_bps)
           VALUES ($1, $2, $3, $4, 1, 100, 100, 100, $5, $6) RETURNING id`,
          [org, doc, lineNo, variant, categoryId, rate],
        );
      const taxable = await line(issued, 1, paints, 1800);
      const exemptLine = await line(issued, 2, exempt, 0);
      const nilLine = await line(issued, 3, nil, 0);
      const draftLine = await line(draft, 1, null, null);
      await client.query(
        `UPDATE tax_documents SET status = 'issued', series_id = $2, number = 'AMP/26-27/000001',
           fy = '2026-27', issued_on = '2026-10-07', issued_at = now(),
           supplier_gstin = '36AABCS1429B1Z5', supplier_state_code = '36', issued_by_member_id = $3,
           supply_type = 'intra_state', place_of_supply_code = '36', gst_class = 'b2cs'
         WHERE id = $1`,
        [issued, series, member],
      );
      return { org, issued, draft, variant, taxable, exemptLine, nilLine, draftLine };
    });

    await migrateDatabase(url);

    await withPgClient(url, async (client) => {
      const natures = await client.query<{ id: string; nature: string | null }>(
        'SELECT id, tax_nature::text AS nature FROM tax_document_lines',
      );
      const byId = new Map(natures.rows.map((row) => [row.id, row.nature]));
      expect(
        [ids.taxable, ids.exemptLine, ids.nilLine, ids.draftLine].map((id) => byId.get(id)),
      ).toEqual(['taxable', 'exempt', 'nil_rated', null]);
      // The immutability trigger is back on.
      await expect(
        client.query("UPDATE tax_document_lines SET tax_nature = 'taxable' WHERE id = $1", [
          ids.exemptLine,
        ]),
      ).rejects.toThrow('tax_document_lines of an issued tax document cannot be changed');
      // A rate always comes with its nature.
      await expect(
        client.query(
          `INSERT INTO tax_document_lines
             (organization_id, document_id, line_no, variant_id, quantity, unit_price_paise, rate_bps)
           VALUES ($1, $2, 2, $3, 1, 100, 1800)`,
          [ids.org, ids.draft, ids.variant],
        ),
      ).rejects.toThrow('tax_document_lines_nature_with_rate');
    });
  });
});

describe('0068_backfills: allocation reversal reasons', () => {
  it('marks the reversals a bounce wrote as cheque_bounce, every other one as undone', async () => {
    const { connectionString: url } = await freshDatabase();
    await migrateDatabase(url, migrationsUpTo('0067_print_settings'));
    const ids = await withPgClient(url, async (client) => {
      // Rows as the old code left them; foreign keys and triggers set aside to keep the setup short.
      await client.query("SET session_replication_role = 'replica'");
      const one = async (text: string, values: unknown[] = []) => {
        const result = await client.query<{ id: string }>(text, values);
        return String(result.rows[0]?.id);
      };
      const org = crypto.randomUUID();
      const party = crypto.randomUUID();
      const payment = (kind: 'cheque' | 'upi', number: string) =>
        one(
          `INSERT INTO payments (organization_id, store_id, number, direction, party_id, mode_id,
             mode_kind, amount_paise, received_on, reference, cheque_date, cheque_status,
             cheque_bounced_on, bounce_reason, created_by_member_id)
           VALUES ($1, gen_random_uuid(), $2, 'in', $3, gen_random_uuid(), $4, 1000, '2026-10-07',
             '000123', $5, $6, $7, $8, gen_random_uuid()) RETURNING id`,
          kind === 'cheque'
            ? [org, number, party, kind, '2026-10-07', 'bounced', '2026-10-09', 'Funds']
            : [org, number, party, kind, null, null, null, null],
        );
      const allocation = (paymentId: string, amount: number, at: string, reverses?: string) =>
        one(
          `INSERT INTO allocations (organization_id, party_id, payment_id, party_ledger_id,
             amount_paise, reverses_allocation_id, created_at)
           VALUES ($1, $2, $3, gen_random_uuid(), $4, $5, $6) RETURNING id`,
          [org, party, paymentId, amount, reverses ?? null, at],
        );
      const cheque = await payment('cheque', 'RC-000001');
      const upi = await payment('upi', 'RC-000002');
      const paid = await allocation(cheque, 100, '2026-10-07 10:00+05:30');
      const bounced = await allocation(cheque, -100, '2026-10-09 23:30+05:30', paid);
      const early = await allocation(cheque, 50, '2026-10-07 10:00+05:30');
      const undoneEarly = await allocation(cheque, -50, '2026-10-08 10:00+05:30', early);
      const plain = await allocation(upi, 70, '2026-10-07 10:00+05:30');
      const undone = await allocation(upi, -70, '2026-10-09 10:00+05:30', plain);
      return { org, party, upi, paid, bounced, undoneEarly, plain, undone };
    });

    await migrateDatabase(url);

    await withPgClient(url, async (client) => {
      const rows = await client.query<{ id: string; reason: string | null }>(
        'SELECT id, reversal_reason::text AS reason FROM allocations',
      );
      const reason = new Map(rows.rows.map((row) => [row.id, row.reason]));
      expect(
        [ids.paid, ids.bounced, ids.undoneEarly, ids.plain, ids.undone].map((id) => reason.get(id)),
      ).toEqual([null, 'cheque_bounce', 'undone', null, 'undone']);
      // Still append-only.
      await expect(
        client.query("UPDATE allocations SET reversal_reason = 'undone' WHERE id = $1", [
          ids.bounced,
        ]),
      ).rejects.toThrow('allocations are append-only');
      // A reversal always says why (triggers aside, the CHECK alone refuses it).
      await client.query("SET session_replication_role = 'replica'");
      await expect(
        client.query(
          `INSERT INTO allocations (organization_id, party_id, payment_id, party_ledger_id,
             amount_paise, reverses_allocation_id)
           VALUES ($1, $2, $3, gen_random_uuid(), -1, gen_random_uuid())`,
          [ids.org, ids.party, ids.upi],
        ),
      ).rejects.toThrow('allocations_reversal_reason');
    });
  });
});

describe('0069_credit_enforcement: hold kinds', () => {
  it('marks every hold already on as put on by a person, and keeps the new rule', async () => {
    const { connectionString: url } = await freshDatabase();
    await migrateDatabase(url, migrationsUpTo('0068_backfills'));
    const ids = await withPgClient(url, async (client) => {
      // Rows as MVP 1 left them; foreign keys set aside to keep the setup short.
      await client.query("SET session_replication_role = 'replica'");
      const profile = async (held: boolean) => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO credit_profiles (organization_id, party_id, status, limit_paise, hold_reason,
             held_at, held_by_member_id)
           VALUES (gen_random_uuid(), gen_random_uuid(), $1, 100000, $2, $3, $4) RETURNING id`,
          held
            ? ['on_hold', 'Cheque bounced', new Date(), crypto.randomUUID()]
            : ['active', null, null, null],
        );
        return String(result.rows[0]?.id);
      };
      return { held: await profile(true), active: await profile(false) };
    });

    await migrateDatabase(url);

    await withPgClient(url, async (client) => {
      const rows = await client.query<{ id: string; kind: string | null }>(
        'SELECT id, hold_kind::text AS kind FROM credit_profiles',
      );
      const kind = new Map(rows.rows.map((row) => [row.id, row.kind]));
      expect([kind.get(ids.held), kind.get(ids.active)]).toEqual(['manual', null]);
      // An automatic hold has no member; a person's always has one.
      await expect(
        client.query("UPDATE credit_profiles SET hold_kind = 'auto' WHERE id = $1", [ids.held]),
      ).rejects.toThrow('credit_profiles_hold_complete');
      await client.query(
        "UPDATE credit_profiles SET hold_kind = 'auto', held_by_member_id = NULL WHERE id = $1",
        [ids.held],
      );
    });
  });
});
