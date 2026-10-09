import { migrateDatabase, withTenant } from '@paint/db';
import {
  LIST_COUNT_CAP,
  type EstimatePage,
  type NotePage,
  type PartyLedgerView,
  type PaymentPage,
  type QuotationPage,
  type RegisterSessionPage,
  type SalesOrderPage,
  type TaxDocumentPage,
  type TaxDocumentView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  issuesOf,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';

// Round 6c: the MVP 2 lists at a large shop's volume (as #15 did for MVP 1's lists).
// One real document of each kind is made through the API, then copied in bulk inside
// the business's tenant scope (row-level security and the audit triggers apply), with
// creation times spread out and three rows per timestamp, so paging must break ties.

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;

const DRAFTS = LIST_COUNT_CAP + 150;
const KKP_DRAFTS = 120;
const NOTES = 300;
const PAYMENTS = 2_500;
const QUOTATIONS = 1_200;
const ORDERS = 1_200;
const ESTIMATES = 1_200;
const SESSIONS = 600;
const LEDGER_ENTRIES = 1_100;

interface Page {
  items: { id: string }[];
  total: number;
  totalCapped: boolean;
  nextCursor: string | null;
}

const get = async <T>(url: string, token = b.owner) => ok(await api(t, token).get(url)).json<T>();

/** Every page of a list, following its cursors; the ids in order. */
async function walk(path: string, limit: number, token = b.owner): Promise<string[]> {
  const ids: string[] = [];
  const glue = path.includes('?') ? '&' : '?';
  let cursor: string | null = null;
  do {
    const query: string = cursor === null ? '' : `&cursor=${cursor}`;
    const page: Page = await get<Page>(`${path}${glue}limit=${String(limit)}${query}`, token);
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return ids;
}

/** Copies a row `count` times in tenant scope, changing the columns `changes` builds. */
async function copy(table: string, id: string, count: number, changes: string): Promise<void> {
  await withTenant(t.connection.db, b.organizationId, (tx) =>
    tx.execute(
      sql.raw(`insert into ${table}
        select (jsonb_populate_record(source, ${changes})).*
        from ${table} source, generate_series(1, ${String(count)}) g
        where source.id = '${id}'`),
    ),
  );
}

/** Creation times: three rows to a timestamp, one timestamp a minute, going back. */
const spread = (column = 'created_at') =>
  `'${column}', clock_timestamp() - ((g / 3) * interval '1 minute') - interval '1 day'`;

/** The ids of a table, newest first, as the lists must return them. */
async function newestIds(table: string, where = 'true', column = 'created_at') {
  const rows = await withTenant(t.connection.db, b.organizationId, (tx) =>
    tx.execute<{ id: string }>(
      sql.raw(`select id from ${table} where ${where} order by ${column} desc, id desc`),
    ),
  );
  return rows.rows.map((row) => row.id);
}

/** The plan PostgreSQL picks for `query`, run as the API runs it (tenant role, business set). */
async function plan(query: string): Promise<string> {
  const rows = await withTenant(t.connection.db, b.organizationId, (tx) =>
    tx.execute<{ 'QUERY PLAN': string }>(sql.raw(`explain ${query}`)),
  );
  return rows.rows.map((row) => row['QUERY PLAN']).join('\n');
}

let ledgerParty: string;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  const o = api(t, b.owner);
  ledgerParty = b.parties.contractor;

  const draft = await b.draft({
    partyId: b.parties.contractor,
    lines: [{ variantId: b.apex, quantity: 1 }],
  });
  const kkpDraft = await b.draft({
    storeId: b.stores.kkp,
    lines: [{ variantId: b.apex, quantity: 1 }],
  });
  const issued = await b.invoice({ partyId: b.parties.contractor, quantity: 3 });
  const lines = ok(await o.get(`/invoices/${issued.id}`)).json<TaxDocumentView>().lines;
  const debit = ok(
    await o.post('/debit-notes', {
      invoiceId: issued.id,
      lines: [{ invoiceLineId: String(lines[0]?.id), valuePaise: 500 }],
    }),
  ).json<{ id: string }>();
  const payment = ok(
    await o.post('/payments', {
      storeId: b.stores.amp,
      partyId: b.parties.contractor,
      modeId: b.modes.upi.id,
      amountPaise: 10_000,
    }),
  ).json<{ id: string }>();
  const quotation = ok(
    await o.post('/quotations', {
      storeId: b.stores.amp,
      billToPartyId: b.parties.homeowner,
      lines: [{ variantId: b.apex, quantity: 2 }],
    }),
  ).json<{ id: string }>();
  const order = ok(
    await o.post('/sales-orders', {
      storeId: b.stores.amp,
      billToPartyId: b.parties.contractor,
      paymentTerms: 'postpaid',
      lines: [{ variantId: b.apex, quantity: 2 }],
    }),
  ).json<{ id: string }>();
  const estimate = ok(
    await o.post('/estimates', {
      storeId: b.stores.amp,
      partyId: b.parties.homeowner,
      title: 'Suresh villa repaint',
      surfaces: [{ room: 'Hall', kind: 'interior_wall', areaSqft: 400, condition: 'repaint' }],
    }),
  ).json<{ id: string }>();
  const session = ok(
    await o.post('/registers/COUNTER-1/open', {
      storeId: b.stores.amp,
      openingFloatPaise: 100_000,
    }),
  ).json<{ id: string }>();
  ok(await o.post(`/register-sessions/${session.id}/close`, { countedCashPaise: 100_000 }));
  const [entry] = (
    await t.connection.db.execute<{ id: string }>(
      sql`select id from party_ledger where party_id = ${ledgerParty} and entry_type = 'invoice'`,
    )
  ).rows;

  const at = spread();
  await copy(
    'tax_documents',
    draft.id,
    DRAFTS,
    `jsonb_build_object('id', gen_random_uuid(), ${at})`,
  );
  await copy(
    'tax_documents',
    kkpDraft.id,
    KKP_DRAFTS,
    `jsonb_build_object('id', gen_random_uuid(), ${at})`,
  );
  await copy(
    'tax_documents',
    debit.id,
    NOTES,
    `jsonb_build_object('id', gen_random_uuid(), 'number', 'DV/' || lpad(g::text, 6, '0'), ${at})`,
  );
  await copy(
    'payments',
    payment.id,
    PAYMENTS,
    `jsonb_build_object('id', gen_random_uuid(), 'number', 'RC-' || (100000 + g), ${at})`,
  );
  await copy(
    'quotations',
    quotation.id,
    QUOTATIONS,
    // A quarter are old versions (superseded), as at a shop that revises its quotes.
    `jsonb_build_object('id', gen_random_uuid(), 'root_quotation_id', null, 'number', 'QT-' || (100000 + g),
       'status', case g % 4 when 0 then 'superseded' when 1 then 'sent' else 'draft' end,
       'sent_at', clock_timestamp(), ${at})`,
  );
  await copy(
    'sales_orders',
    order.id,
    ORDERS,
    `jsonb_build_object('id', gen_random_uuid(), 'number', 'SO-' || (100000 + g), ${at})`,
  );
  await copy(
    'estimates',
    estimate.id,
    ESTIMATES,
    `jsonb_build_object('id', gen_random_uuid(), 'number', 'ES-' || (100000 + g), ${at})`,
  );
  await copy(
    'register_sessions',
    session.id,
    SESSIONS,
    `jsonb_build_object('id', gen_random_uuid(), ${spread('opened_at')}, ${spread('closed_at')})`,
  );
  // A busy contractor: entries over 400 days, several to a day, three to a timestamp.
  await copy(
    'party_ledger',
    String(entry?.id),
    LEDGER_ENTRIES,
    `jsonb_build_object('id', gen_random_uuid(), 'reference_type', null, 'reference_id', null,
       'entry_on', current_date - 1 - (g % 400), 'amount_paise', 100 + g, ${at})`,
  );
  for (const table of [
    'tax_documents',
    'payments',
    'quotations',
    'sales_orders',
    'estimates',
    'register_sessions',
    'party_ledger',
    'parties',
  ]) {
    await t.connection.db.execute(sql.raw(`analyze ${table}`));
  }
}, 300_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('counts at a large shop', () => {
  it('stop at the cap, and say so', async () => {
    const page = await get<TaxDocumentPage>('/invoices?limit=50');
    expect(page.items).toHaveLength(50);
    expect(page).toMatchObject({ total: LIST_COUNT_CAP, totalCapped: true });
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it('are exact below the cap, whatever the filters', async () => {
    expect(
      await get<TaxDocumentPage>('/invoices?kinds=invoice,bill_of_supply&status=issued&limit=1'),
    ).toMatchObject({
      total: 1,
      totalCapped: false,
    });
    expect(await get<NotePage>('/notes?limit=1')).toMatchObject({
      total: NOTES + 1,
      totalCapped: false,
    });
    expect(
      await get<PaymentPage>(`/payments?partyId=${b.parties.contractor}&limit=1`),
    ).toMatchObject({ total: PAYMENTS + 1, totalCapped: false });
    expect(await get<QuotationPage>('/quotations?q=suresh&limit=1')).toMatchObject({
      total: QUOTATIONS - QUOTATIONS / 4 + 1,
    });
    expect(await get<QuotationPage>('/quotations?allVersions=true&limit=1')).toMatchObject({
      total: QUOTATIONS + 1,
    });
    expect(await get<SalesOrderPage>('/sales-orders?status=draft&limit=1')).toMatchObject({
      total: ORDERS + 1,
    });
    expect(await get<EstimatePage>('/estimates?q=villa&limit=1')).toMatchObject({
      total: ESTIMATES + 1,
    });
    expect(
      await get<RegisterSessionPage>(`/register-sessions?storeId=${b.stores.amp}&limit=1`),
    ).toMatchObject({ total: SESSIONS + 1 });
  });
});

describe('keyset paging at a large shop', () => {
  it.each([
    ['/notes', 'tax_documents', `kind in ('credit_note', 'debit_note')`, 'created_at', 70],
    ['/payments', 'payments', 'true', 'created_at', 200],
    ['/quotations', 'quotations', `status <> 'superseded'`, 'created_at', 200],
    ['/sales-orders', 'sales_orders', 'true', 'created_at', 200],
    ['/estimates', 'estimates', 'true', 'created_at', 200],
    ['/register-sessions', 'register_sessions', 'true', 'opened_at', 200],
  ])('walks every row of %s once, newest first', async (path, table, where, column, limit) => {
    const expected = await newestIds(table, where, column);
    expect(expected.length).toBeGreaterThan(NOTES);
    expect(await walk(path, limit)).toEqual(expected);
  });

  it('walks the invoices of one store as its manager sees them', async () => {
    const manager = await b.member('branch_manager', [b.stores.kkp]);
    const expected = await newestIds('tax_documents', `store_id = '${b.stores.kkp}'`);
    expect(expected).toHaveLength(KKP_DRAFTS + 1);
    expect(await walk('/invoices', 50, manager)).toEqual(expected);
  });

  it('gives the same rows by cursor as by offset, and the same next page', async () => {
    const first = await get<SalesOrderPage>('/sales-orders?limit=100');
    const byOffset = await get<SalesOrderPage>('/sales-orders?limit=100&offset=100');
    const byCursor = await get<SalesOrderPage>(
      `/sales-orders?limit=100&offset=900&cursor=${String(first.nextCursor)}`,
    );
    expect(byCursor.items).toEqual(byOffset.items);
    expect(byCursor.nextCursor).toBe(byOffset.nextCursor);
    expect(byCursor.total).toBe(first.total);
  });

  it('refuses a cursor it did not give out', async () => {
    const reply = await api(t, b.owner).get('/invoices?cursor=bm90LWEtY3Vyc29y');
    expect(reply.statusCode).toBe(400);
    expect(issuesOf(reply)).toEqual(['cursor']);
  });
});

describe("a busy contractor's ledger", () => {
  const ledger = (query: string) => get<PartyLedgerView>(`/parties/${ledgerParty}/ledger?${query}`);

  it('pages oldest first, each page opening where the last one closed', async () => {
    const whole = await ledger('limit=500&from=2000-01-01');
    let page = whole;
    const ids = [...page.entries.map((entry) => entry.id)];
    let closing = page.closingPaise;
    expect(page.openingPaise).toBe(0);
    while (page.nextCursor !== null) {
      page = await ledger(`limit=500&from=2000-01-01&cursor=${page.nextCursor}`);
      expect(page.openingPaise).toBe(closing);
      ids.push(...page.entries.map((entry) => entry.id));
      closing = page.closingPaise;
    }
    const all = await t.connection.db.execute<{ id: string; total: string }>(
      sql`select id, sum(amount_paise) over () as total from party_ledger
          where party_id = ${ledgerParty} order by entry_on, created_at, id`,
    );
    expect(ids).toEqual(all.rows.map((row) => row.id));
    expect(closing).toBe(Number(all.rows[0]?.total));
    expect(page.balancePaise).toBe(whole.balancePaise);
  });

  it('opens a later page of a period with the entries before the period too', async () => {
    const from = (
      await t.connection.db.execute<{ day: string }>(sql`select (current_date - 200)::text as day`)
    ).rows[0]?.day;
    const first = await ledger(`from=${String(from)}&limit=100`);
    const second = await ledger(
      `from=${String(from)}&limit=100&cursor=${String(first.nextCursor)}`,
    );
    expect(first.openingPaise).toBeGreaterThan(0);
    expect(second.openingPaise).toBe(first.closingPaise);
    expect(String(second.entries[0]?.entryOn) >= String(from)).toBe(true);
  });

  it('refuses a list cursor in place of a ledger cursor', async () => {
    const page = await get<PaymentPage>('/payments?limit=1');
    const reply = await api(t, b.owner).get(
      `/parties/${ledgerParty}/ledger?cursor=${String(page.nextCursor)}`,
    );
    expect(reply.statusCode).toBe(400);
    expect(issuesOf(reply)).toEqual(['cursor']);
  });
});

describe('query plans at a large shop', () => {
  /** The key of the row halfway down `table`'s newest-first list, as a cursor carries it. */
  async function middleKey(table: string, where: string, column = 'created_at') {
    const rows = await withTenant(t.connection.db, b.organizationId, (tx) =>
      tx.execute<{ at: string; id: string }>(
        sql.raw(`select to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, id
                 from ${table} where ${where} order by ${column} desc, id desc
                 offset (select count(*) / 2 from ${table} where ${where}) limit 1`),
      ),
    );
    const [row] = rows.rows;
    return `('${String(row?.at)}'::timestamptz, '${String(row?.id)}'::uuid)`;
  }

  it.each([
    [
      'invoices',
      'tax_documents',
      'tax_documents_organization_created_idx',
      `kind in ('invoice', 'bill_of_supply')`,
    ],
    [
      'notes',
      'tax_documents',
      'tax_documents_organization_created_idx',
      `kind in ('credit_note', 'debit_note')`,
    ],
    ['payments', 'payments', 'payments_organization_created_idx', 'true'],
    ['quotations', 'quotations', 'quotations_organization_created_idx', `status <> 'superseded'`],
    ['sales orders', 'sales_orders', 'sales_orders_organization_created_idx', 'true'],
    ['estimates', 'estimates', 'estimates_organization_created_idx', 'true'],
  ])('reads a page halfway down %s straight from %s', async (_, table, index, where) => {
    await expectPagePlan(table, index, where);
  });

  // Round 6a's indexes (migration 0065), from this round's EXPLAIN findings.
  it("reads a page halfway down one store's invoices (a branch manager's list) from its store index", async () => {
    await expectPagePlan(
      'tax_documents',
      'tax_documents_store_created_idx',
      // A small branch: where the business-wide index would skip past most rows.
      `store_id in ('${b.stores.kkp}') and kind in ('invoice', 'bill_of_supply')`,
    );
  });

  it('reads a page halfway down every store’s register sessions from the business index', async () => {
    await expectPagePlan(
      'register_sessions',
      'register_sessions_organization_opened_idx',
      'true',
      'opened_at',
    );
  });

  async function expectPagePlan(
    table: string,
    index: string,
    where: string,
    column = 'created_at',
  ) {
    const key = await middleKey(table, where, column);
    const found = await plan(
      `select id from ${table} where ${where} and (${column}, id) < ${key}
       order by ${column} desc, id desc limit 51`,
    );
    expect(found).toContain(`Scan using ${index} `);
    // The cursor is part of the index condition: the scan starts at it, not at the top.
    expect(found).toMatch(new RegExp(`Index Cond: .*ROW\\(${column}, id\\) <`));
    expect(found).not.toContain('Sort');
    expect(found).not.toContain('Seq Scan');
  }

  it("reads a page of a party's ledger from its index", async () => {
    const found = await plan(
      `select id from party_ledger where party_id = '${ledgerParty}'
         and (entry_on, created_at, id) > (current_date - 200, now(), '00000000-0000-0000-0000-000000000000')
       order by entry_on, created_at, id limit 201`,
    );
    expect(found).toContain('Index Scan using party_ledger_party_idx');
    expect(found).not.toContain('Seq Scan');
  });
});
