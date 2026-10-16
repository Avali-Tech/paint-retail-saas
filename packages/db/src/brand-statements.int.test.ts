import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

// MVP 3 round 6a (migrations 0088–0091): brand statement templates, imported statements,
// their lines and how each line was settled; the validity of links sent in messages.

const {
  auditLog,
  brandBenefitReceipts,
  brandSchemes,
  brandStatementLines,
  brandStatementMatches,
  brandStatementTemplates,
  brandStatements,
  brands,
  goodsReceipts,
  organizationMembers,
  organizations,
  parties,
  roles,
  salesSettings,
  stores,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;

interface Tenant {
  readonly org: string;
  readonly member: string;
  readonly store: string;
  readonly supplier: string;
  readonly otherSupplier: string;
  readonly brand: string;
  readonly otherBrand: string;
  readonly grn: string;
  readonly otherGrn: string;
  readonly receipt: string;
  readonly otherReceipt: string;
  readonly template: string;
}
let a: Tenant;
let b: Tenant;

async function failureMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const { message, cause } = error as Error;
    return `${message} ${cause instanceof Error ? cause.message : ''}`;
  }
  throw new Error('Expected the query to fail, but it succeeded');
}

function id(rows: { id: string }[]): string {
  const [row] = rows;
  if (!row) throw new Error('Expected a row');
  return row.id;
}

type TemplateValues = Partial<typeof brandStatementTemplates.$inferInsert>;
let templateNames = 0;
const template = (t: Pick<Tenant, 'org' | 'member' | 'supplier'>, values: TemplateValues = {}) => {
  templateNames += 1;
  return withTenant(connection.db, t.org, async (tx) =>
    id(
      await tx
        .insert(brandStatementTemplates)
        .values({
          organizationId: t.org,
          name: `Ledger ${String(templateNames)}`,
          supplierPartyId: t.supplier,
          dateColumn: 'Date',
          documentColumn: 'Doc No',
          amountMode: 'debit_credit',
          debitColumn: 'Debit',
          creditColumn: 'Credit',
          createdByMemberId: t.member,
          ...values,
        })
        .returning(),
    ),
  );
};

async function tenant(name: string): Promise<Tenant> {
  const { db } = connection;
  const org = id(await db.insert(organizations).values({ name }).returning());
  const store = id(
    await db
      .insert(stores)
      .values({ organizationId: org, name: 'Ameerpet', code: 'AMP' })
      .returning(),
  );
  const role = id(
    await db.insert(roles).values({ organizationId: org, key: 'x', name: 'X' }).returning(),
  );
  const user = id(
    await db
      .insert(users)
      .values({ fullName: 'Ravi', email: `ravi-${crypto.randomUUID()}@example.com` })
      .returning(),
  );
  const member = id(
    await db
      .insert(organizationMembers)
      .values({ organizationId: org, userId: user, roleId: role })
      .returning(),
  );
  const party = async (displayName: string) =>
    id(await db.insert(parties).values({ organizationId: org, displayName }).returning());
  const supplier = await party('Distributor');
  const otherSupplier = await party('Other distributor');
  const brand = id(
    await db.insert(brands).values({ organizationId: org, name: 'Apex Paints' }).returning(),
  );
  const otherBrand = id(
    await db.insert(brands).values({ organizationId: org, name: 'Other Paints' }).returning(),
  );
  const grnOf = async (number: string, supplierPartyId: string) =>
    id(
      await db
        .insert(goodsReceipts)
        .values({
          organizationId: org,
          number,
          storeId: store,
          supplierPartyId,
          receivedByMemberId: member,
        })
        .returning(),
    );
  const grn = await grnOf('GRN-000001', supplier);
  const otherGrn = await grnOf('GRN-000002', otherSupplier);
  const schemeOf = async (brandId: string) =>
    id(
      await db
        .insert(brandSchemes)
        .values({
          organizationId: org,
          brandId,
          name: 'Quarter',
          startsOn: '2026-07-01',
          endsOn: '2026-09-30',
          measure: 'value',
          status: 'active',
          createdByMemberId: member,
        })
        .returning(),
    );
  const receiptOf = async (schemeId: string) =>
    id(
      await db
        .insert(brandBenefitReceipts)
        .values({
          organizationId: org,
          schemeId,
          kind: 'money',
          receivedOn: '2026-09-20',
          amountPaise: 50_000,
          moneyForm: 'credit_note',
          reference: 'CN-881',
          recordedByMemberId: member,
        })
        .returning(),
    );
  const receipt = await receiptOf(await schemeOf(brand));
  const otherReceipt = await receiptOf(await schemeOf(otherBrand));
  const base = { org, member, supplier };
  return {
    ...base,
    store,
    otherSupplier,
    brand,
    otherBrand,
    grn,
    otherGrn,
    receipt,
    otherReceipt,
    template: await template(base, { brandId: brand }),
  };
}

type StatementValues = Partial<typeof brandStatements.$inferInsert>;
let statementNumbers = 0;
const statement = (t: Tenant, values: StatementValues = {}) => {
  statementNumbers += 1;
  return withTenant(connection.db, t.org, async (tx) =>
    id(
      await tx
        .insert(brandStatements)
        .values({
          organizationId: t.org,
          number: `BS-${String(statementNumbers).padStart(6, '0')}`,
          templateId: t.template,
          supplierPartyId: t.supplier,
          brandId: t.brand,
          periodFrom: '2026-12-01',
          periodTo: '2026-12-31',
          fileName: 'September.csv',
          contentType: 'text/csv',
          sizeBytes: 120,
          sha256: crypto.randomUUID().replaceAll('-', '').padEnd(64, '0'),
          uploadedByMemberId: t.member,
          ...values,
        })
        .returning(),
    ),
  );
};
const setStatement = (t: Tenant, statementId: string, values: StatementValues) =>
  withTenant(connection.db, t.org, (tx) =>
    tx.update(brandStatements).set(values).where(eq(brandStatements.id, statementId)),
  );

type LineValues = Partial<typeof brandStatementLines.$inferInsert>;
let rows = 1;
const line = (t: Tenant, statementId: string, values: LineValues = {}) => {
  rows += 1;
  return withTenant(connection.db, t.org, async (tx) =>
    id(
      await tx
        .insert(brandStatementLines)
        .values({
          organizationId: t.org,
          statementId,
          rowNumber: rows,
          lineDate: '2026-09-05',
          kind: 'invoice',
          documentNumber: 'INV/881',
          amountPaise: 118_000,
          ...values,
        })
        .returning(),
    ),
  );
};

type MatchValues = Partial<typeof brandStatementMatches.$inferInsert>;
const match = (t: Tenant, statementId: string, lineId: string, values: MatchValues = {}) =>
  withTenant(connection.db, t.org, async (tx) =>
    id(
      await tx
        .insert(brandStatementMatches)
        .values({
          organizationId: t.org,
          statementId,
          lineId,
          source: 'auto',
          goodsReceiptId: t.grn,
          differencePaise: 0,
          ...values,
        })
        .returning(),
    ),
  );

const audit = (table: string, recordId: string) =>
  connection.db
    .select({ action: auditLog.action, newValues: auditLog.newValues })
    .from(auditLog)
    .where(sql`${auditLog.tableName} = ${table} and ${auditLog.recordId} = ${recordId}`)
    .orderBy(auditLog.id);

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  connection = createDatabase(database.connectionString);
  a = await tenant('ABC Paints');
  b = await tenant('XYZ Paints');
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('statement templates', () => {
  it('default to a week, ₹1 and GST-inclusive GRNs, and check their columns and ranges', async () => {
    const [row] = await connection.db
      .select()
      .from(brandStatementTemplates)
      .where(eq(brandStatementTemplates.id, a.template));
    expect(row).toMatchObject({
      headerRowsToSkip: 0,
      signConvention: 'debit_positive',
      dateFormat: 'dd-mm-yyyy',
      typeRules: {},
      dateWindowDays: 7,
      amountTolerancePaise: 100,
      grnAmountBasis: 'with_gst',
      isActive: true,
    });
    expect(await failureMessage(template(a, { debitColumn: null }))).toMatch(
      /brand_statement_templates_amount_columns/,
    );
    expect(
      await failureMessage(template(a, { amountMode: 'signed', amountColumn: 'Amount' })),
    ).toMatch(/brand_statement_templates_amount_columns/);
    await template(a, {
      amountMode: 'signed',
      debitColumn: null,
      creditColumn: null,
      amountColumn: 'Amount',
      signConvention: 'credit_positive',
    });
    expect(await failureMessage(template(a, { dateWindowDays: 61 }))).toMatch(
      /brand_statement_templates_ranges/,
    );
    expect(await failureMessage(template(a, { amountTolerancePaise: 100_001 }))).toMatch(
      /brand_statement_templates_ranges/,
    );
    expect(await failureMessage(template(a, { headerRowsToSkip: 51 }))).toMatch(
      /brand_statement_templates_ranges/,
    );
    expect(await failureMessage(template(a, { typeRules: [] as never }))).toMatch(
      /brand_statement_templates_ranges/,
    );
    expect(await failureMessage(template(a, { name: ' Padded ' }))).toMatch(
      /brand_statement_templates_text/,
    );
    expect(await failureMessage(template(a, { typeColumn: '' }))).toMatch(
      /brand_statement_templates_text/,
    );
    expect(await failureMessage(template(a, { name: 'LEDGER 1' }))).toMatch(
      /brand_statement_templates_name_unique/,
    );
    expect(await failureMessage(template(a, { brandId: b.brand }))).toMatch(
      /brand_statement_templates_brand_fk/,
    );
  });

  it('keep their supplier and author, are switched off, never deleted, and are audited', async () => {
    const kept = await template(a);
    const set = (values: TemplateValues) =>
      withTenant(connection.db, a.org, (tx) =>
        tx.update(brandStatementTemplates).set(values).where(eq(brandStatementTemplates.id, kept)),
      );
    await set({ dateWindowDays: 3, isActive: false });
    expect(await failureMessage(set({ supplierPartyId: a.otherSupplier }))).toMatch(
      /keeps its business, supplier and author/,
    );
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.delete(brandStatementTemplates).where(eq(brandStatementTemplates.id, kept)),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await failureMessage(
        connection.db.delete(brandStatementTemplates).where(eq(brandStatementTemplates.id, kept)),
      ),
    ).toMatch(/never deleted: switch it off/);
    expect((await audit('brand_statement_templates', kept)).map((row) => row.action)).toEqual([
      'insert',
      'update',
    ]);
  });

  it('are visible only to their business', async () => {
    const seen = await withTenant(connection.db, b.org, (tx) =>
      tx.select().from(brandStatementTemplates).where(eq(brandStatementTemplates.id, a.template)),
    );
    expect(seen).toEqual([]);
  });
});

describe('brand statements', () => {
  it('are numbered, checked, and one per supplier, period and file while active', async () => {
    const sha = 'a'.repeat(64);
    const first = await statement(a, {
      periodFrom: '2026-01-01',
      periodTo: '2026-01-31',
      sha256: sha,
    });
    expect(
      await failureMessage(
        statement(a, { periodFrom: '2026-02-01', periodTo: '2026-02-28', sha256: sha }),
      ),
    ).toMatch(/brand_statements_file_unique/);
    expect(
      await failureMessage(statement(a, { periodFrom: '2026-01-01', periodTo: '2026-01-31' })),
    ).toMatch(/brand_statements_period_unique/);
    expect(await failureMessage(statement(a, { number: 'XX-1' }))).toMatch(
      /brand_statements_number_format/,
    );
    expect(
      await failureMessage(statement(a, { periodFrom: '2026-03-01', periodTo: '2026-02-01' })),
    ).toMatch(/brand_statements_period/);
    expect(
      await failureMessage(statement(a, { periodFrom: '2025-01-01', periodTo: '2026-01-02' })),
    ).toMatch(/brand_statements_period/);
    expect(await failureMessage(statement(a, { sha256: 'nothex' }))).toMatch(
      /brand_statements_file/,
    );
    expect(await failureMessage(statement(a, { status: 'discarded' }))).toMatch(
      /brand_statements_discarded/,
    );
    // Discarded, its period and file are free again.
    await setStatement(a, first, {
      status: 'discarded',
      discardedAt: new Date(),
      discardedByMemberId: a.member,
    });
    await statement(a, { periodFrom: '2026-01-01', periodTo: '2026-01-31', sha256: sha });
  });

  it('do not change once imported, are discarded once, never deleted, and are audited', async () => {
    const kept = await statement(a, { periodFrom: '2026-04-01', periodTo: '2026-04-30' });
    await setStatement(a, kept, { matchedAt: new Date() });
    expect(await failureMessage(setStatement(a, kept, { periodTo: '2026-04-29' }))).toMatch(
      /an imported brand statement does not change/,
    );
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.delete(brandStatements).where(eq(brandStatements.id, kept)),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await failureMessage(
        connection.db.delete(brandStatements).where(eq(brandStatements.id, kept)),
      ),
    ).toMatch(/never deleted: discard it/);
    await setStatement(a, kept, {
      status: 'discarded',
      discardedAt: new Date(),
      discardedByMemberId: a.member,
    });
    expect(await failureMessage(setStatement(a, kept, { matchedAt: new Date() }))).toMatch(
      /a discarded brand statement does not change/,
    );
    await setStatement(a, kept, { updatedAt: new Date() });
    // Only the discarding is audited: when it was last matched is not watched.
    expect((await audit('brand_statements', kept)).map((row) => row.action)).toEqual([
      'insert',
      'update',
    ]);
  });
});

describe('statement lines', () => {
  it('are written once to an active statement, checked, and never changed', async () => {
    const kept = await statement(a, { periodFrom: '2026-05-01', periodTo: '2026-05-31' });
    const first = await line(a, kept, { rowNumber: 2 });
    expect(await failureMessage(line(a, kept, { rowNumber: 2 }))).toMatch(
      /brand_statement_lines_row_unique/,
    );
    expect(await failureMessage(line(a, kept, { amountPaise: 0 }))).toMatch(
      /brand_statement_lines_values/,
    );
    await line(a, kept, { kind: 'opening', amountPaise: 0, documentNumber: null });
    expect(await failureMessage(line(a, kept, { documentNumber: '' }))).toMatch(
      /brand_statement_lines_values/,
    );
    expect(await failureMessage(line(a, kept, { rowNumber: 0 }))).toMatch(
      /brand_statement_lines_values/,
    );
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx
            .update(brandStatementLines)
            .set({ amountPaise: 1 })
            .where(eq(brandStatementLines.id, first)),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await failureMessage(
        connection.db
          .update(brandStatementLines)
          .set({ amountPaise: 1 })
          .where(eq(brandStatementLines.id, first)),
      ),
    ).toMatch(/a statement line is never changed/);
    expect(
      await failureMessage(
        connection.db.delete(brandStatementLines).where(eq(brandStatementLines.id, first)),
      ),
    ).toMatch(/a statement line is never changed/);
    await setStatement(a, kept, {
      status: 'discarded',
      discardedAt: new Date(),
      discardedByMemberId: a.member,
    });
    expect(await failureMessage(line(a, kept))).toMatch(
      /lines are added only to an active statement/,
    );
  });

  it('go with their business when the platform deletes it', async () => {
    const gone = await tenant('Gone Paints');
    const kept = await statement(gone, { periodFrom: '2026-06-01', periodTo: '2026-06-30' });
    const lineId = await line(gone, kept);
    await match(gone, kept, lineId);
    // Statements are never deleted by tenants; the platform removes a whole business.
    await connection.db.execute(
      sql`alter table brand_statements disable trigger brand_statements_fixed`,
    );
    try {
      await connection.db.delete(brandStatements).where(eq(brandStatements.id, kept));
    } finally {
      await connection.db.execute(
        sql`alter table brand_statements enable trigger brand_statements_fixed`,
      );
    }
    const left = await connection.db
      .select()
      .from(brandStatementLines)
      .where(eq(brandStatementLines.statementId, kept));
    expect(left).toEqual([]);
  });
});

describe('statement matches', () => {
  it("settle a line once, with the supplier's GRN or the brand's scheme money", async () => {
    const kept = await statement(a, { periodFrom: '2026-07-01', periodTo: '2026-07-31' });
    const invoice = await line(a, kept);
    const creditNote = await line(a, kept, { kind: 'credit_note', amountPaise: -50_000 });
    const other = await line(a, kept);
    const auto = await match(a, kept, invoice);
    expect(
      await failureMessage(
        match(a, kept, invoice, { goodsReceiptId: null, benefitReceiptId: a.receipt }),
      ),
    ).toMatch(/brand_statement_matches_line_unique/);
    expect(await failureMessage(match(a, kept, other))).toMatch(
      /brand_statement_matches_grn_unique/,
    );
    expect(await failureMessage(match(a, kept, other, { goodsReceiptId: a.otherGrn }))).toMatch(
      /not from the statement's supplier/,
    );
    expect(
      await failureMessage(
        match(a, kept, creditNote, { goodsReceiptId: null, benefitReceiptId: a.otherReceipt }),
      ),
    ).toMatch(/not scheme money of the statement's brand/);
    await match(a, kept, creditNote, {
      source: 'manual',
      goodsReceiptId: null,
      benefitReceiptId: a.receipt,
      memberId: a.member,
    });
    expect(
      await failureMessage(
        match(a, kept, other, {
          source: 'explained',
          goodsReceiptId: null,
          differencePaise: null,
        }),
      ),
    ).toMatch(/brand_statement_matches_target/);
    expect(
      await failureMessage(match(a, kept, other, { source: 'manual', memberId: null })),
    ).toMatch(/brand_statement_matches_target/);
    expect(
      await failureMessage(
        match(a, kept, other, { source: 'explained', differencePaise: null, memberId: a.member }),
      ),
    ).toMatch(/brand_statement_matches_target/);
    const explained = await match(a, kept, other, {
      source: 'explained',
      goodsReceiptId: null,
      differencePaise: null,
      note: 'Freight charged by the distributor',
      memberId: a.member,
    });
    // A rejected pair is remembered beside the line's settlement.
    await match(a, kept, other, {
      source: 'rejected',
      differencePaise: null,
      memberId: a.member,
    });
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx
            .update(brandStatementMatches)
            .set({ note: 'Changed' })
            .where(eq(brandStatementMatches.id, explained)),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await failureMessage(
        connection.db
          .update(brandStatementMatches)
          .set({ note: 'Changed' })
          .where(eq(brandStatementMatches.id, explained)),
      ),
    ).toMatch(/never changed: remove it and match again/);
    await withTenant(connection.db, a.org, (tx) =>
      tx.delete(brandStatementMatches).where(eq(brandStatementMatches.id, auto)),
    );
    expect((await audit('brand_statement_matches', auto)).map((row) => row.action)).toEqual([
      'insert',
      'delete',
    ]);
    await withTenant(connection.db, a.org, (tx) =>
      tx.delete(brandStatementMatches).where(eq(brandStatementMatches.statementId, kept)),
    );
    await setStatement(a, kept, {
      status: 'discarded',
      discardedAt: new Date(),
      discardedByMemberId: a.member,
    });
    expect(await failureMessage(match(a, kept, invoice))).toMatch(
      /lines of a discarded statement are not matched/,
    );
  });

  it('are visible only to their business', async () => {
    const kept = await statement(a, { periodFrom: '2026-08-01', periodTo: '2026-08-31' });
    await match(a, kept, await line(a, kept));
    const seen = await withTenant(connection.db, b.org, (tx) =>
      tx.select().from(brandStatementMatches).where(eq(brandStatementMatches.statementId, kept)),
    );
    expect(seen).toEqual([]);
  });
});

describe('message link validity', () => {
  it('is a day by default, 5 minutes to 30 days, and audited', async () => {
    await withTenant(connection.db, a.org, (tx) =>
      tx.insert(salesSettings).values({ organizationId: a.org }),
    );
    const set = (messageLinkValidityMinutes: number) =>
      withTenant(connection.db, a.org, (tx) =>
        tx
          .update(salesSettings)
          .set({ messageLinkValidityMinutes })
          .where(eq(salesSettings.organizationId, a.org)),
      );
    const [row] = await connection.db
      .select({ minutes: salesSettings.messageLinkValidityMinutes })
      .from(salesSettings)
      .where(eq(salesSettings.organizationId, a.org));
    expect(row?.minutes).toBe(1440);
    expect(await failureMessage(set(4))).toMatch(/sales_settings_message_link_validity/);
    expect(await failureMessage(set(43_201))).toMatch(/sales_settings_message_link_validity/);
    await set(60);
    const entries = await connection.db
      .select({ newValues: auditLog.newValues })
      .from(auditLog)
      .where(
        sql`${auditLog.tableName} = 'sales_settings' and ${auditLog.action} = 'update'
          and ${auditLog.organizationId} = ${a.org}`,
      );
    expect(entries.map((entry) => entry.newValues)).toEqual([
      { message_link_validity_minutes: 60 },
    ]);
  });
});
