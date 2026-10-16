import { migrateDatabase } from '@paint/db';
import type {
  BrandStatementDetail,
  BrandStatementSummaryView,
  MatchRunResult,
  SchemeDetail,
  SchemeView,
  StatementPreview,
  StatementTemplateView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { api, ok } from '../test-support/billing-business.js';
import { EICAR, multipartBody, testBucket } from '../test-support/files.js';
import { seedSchemeBusiness, type SchemeBusiness } from '../test-support/scheme-business.js';
import { csvFile, xlsxFile } from '../test-support/statement-files.js';
import { bearer, startTestApp, type TestApp } from '../test-support/test-app.js';

// Brand statement reconciliation (P2-M34, round 6a): templates, import of a month's
// statement (CSV and Excel), matching with GRNs and scheme money, members' matches and
// explanations, recording a scheme credit note from a line, the mismatch list, and
// keeping the original file after a virus scan.

let database: TestDatabase;
let t: TestApp;
let biz: SchemeBusiness;
let monsoonId: string;
let otherGrn: string;

const owner = () => api(t, biz.owner);

const HEADER = ['Date', 'Doc No', 'Type', 'Narration', 'Debit', 'Credit'];
/**
 * Deccan Distributors' July: AD/101 and BG/201 as we have them, AD/103 ₹250 more than
 * our GRN, AD/199 we never received, a scheme credit note we recorded (CN/7781) and
 * one we did not (CN/7790), our payment, and a closing total.
 */
const JULY = [
  ['Deccan Distributors - ledger July 2026'],
  HEADER,
  ['01-07-2026', '', 'Opening Balance', '', '10,000.00', ''],
  ['09-07-2026', 'AD/101', 'Invoice', 'Ultima 20 L', '40,000.00', ''],
  ['15-07-2026', 'AD/103', 'Invoice', 'Wall Putty', '5,250.00', ''],
  ['20-07-2026', 'BG/201', 'Invoice', 'Silk', '15,000.00', ''],
  ['22-07-2026', 'AD/199', 'Invoice', 'Not received', '7,000.00', ''],
  ['25-07-2026', 'CN/7781', 'Credit Note', 'Monsoon scheme', '', '1,200.00'],
  ['28-07-2026', 'CN/7790', 'Credit Note', 'Monsoon scheme, part 2', '', '800.00'],
  ['30-07-2026', 'UTR555', 'Receipt', 'Thank you', '', '50,000.00'],
  ['', '', 'Total', '', '77,250.00', '52,000.00'],
];

const template = () => ({
  name: 'Deccan ledger',
  supplierPartyId: biz.supplier,
  brandId: biz.brands.apex,
  headerRowsToSkip: 1,
  dateColumn: 'Date',
  documentColumn: 'Doc No',
  typeColumn: 'Type',
  descriptionColumn: 'Narration',
  amountMode: 'debit_credit',
  debitColumn: 'Debit',
  creditColumn: 'Credit',
  dateFormat: 'dd-mm-yyyy',
  typeRules: { opening: ['Opening'], credit_note: ['Credit Note'], payment: ['Receipt'] },
  dateWindowDays: 7,
  amountTolerancePaise: 100,
  grnAmountBasis: 'taxable',
});
let templateId: string;

function upload(
  url: string,
  fields: Record<string, string>,
  file: { fileName: string; data: Buffer } | null,
  app: TestApp = t,
  token = biz.owner,
) {
  const { payload, headers } = multipartBody(fields, file === null ? [] : [file]);
  return app.app.inject({
    method: 'POST',
    url,
    headers: { ...bearer(token), ...headers },
    payload,
  });
}

const julyFile = () => ({ fileName: 'July.csv', data: csvFile(JULY) });
/** A statement file with a title row, the header and these rows. */
const ledger = (...rows: string[][]) => csvFile([['Ledger'], HEADER, ...rows]);

const lineOf = (detail: BrandStatementDetail, document: string | null, kind?: string) => {
  const found = detail.lines.find(
    (line) => line.documentNumber === document && (kind === undefined || line.kind === kind),
  );
  if (!found) throw new Error(`No line ${String(document)}`);
  return found;
};

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  biz = await seedSchemeBusiness(t);
  // A July GRN the statement does not show.
  const grn = ok(
    await owner().post('/goods-receipts', {
      storeId: biz.stores.hyd,
      supplierId: biz.supplier,
      supplierInvoiceNumber: 'AD/150',
      supplierInvoiceDate: '2026-07-18',
      lines: [{ variantId: biz.variants.ultima10, quantity: 1, unitCostPaise: 2_000_00 }],
    }),
  ).json<{ id: string }>();
  otherGrn = grn.id;
  // The Monsoon scheme, with the first credit note recorded.
  const scheme = ok(
    await owner().post('/brand-schemes', {
      brandId: biz.brands.apex,
      name: 'Monsoon slab',
      startsOn: '2026-07-01',
      endsOn: '2026-09-30',
      measure: 'value',
      slabs: [{ target: 50_000_00, benefits: [{ kind: 'rebate', basisPoints: 100 }] }],
    }),
  ).json<SchemeView>();
  monsoonId = scheme.id;
  ok(await owner().post(`/brand-schemes/${monsoonId}/activate`));
  ok(
    await owner().post(`/brand-schemes/${monsoonId}/receipts`, {
      kind: 'money',
      amountPaise: 1_200_00,
      moneyForm: 'credit_note',
      receivedOn: '2026-07-26',
      reference: 'CN-7781',
    }),
  );
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('who may see and reconcile statements', () => {
  it('lets purchasing see statements, only owners and admins change them, and nobody else in', async () => {
    expect((await api(t, biz.cashier).get('/brand-statements')).statusCode).toBe(403);
    expect((await api(t, biz.buyer).get('/brand-statements')).statusCode).toBe(200);
    expect((await api(t, biz.buyer).get('/brand-statements/templates')).statusCode).toBe(200);
    expect(
      (await api(t, biz.buyer).post('/brand-statements/templates', template())).statusCode,
    ).toBe(403);
    expect(
      (await upload('/brand-statements/preview', {}, julyFile(), t, biz.buyer)).statusCode,
    ).toBe(403);
  });
});

describe('statement templates', () => {
  it('are made once per supplier, checked, and changed but never moved to another supplier', async () => {
    const created = ok(
      await owner().post('/brand-statements/templates', template()),
    ).json<StatementTemplateView>();
    templateId = created.id;
    expect(created).toMatchObject({
      name: 'Deccan ledger',
      supplier: { id: biz.supplier, name: 'Deccan Distributors' },
      brand: { id: biz.brands.apex, name: 'Apex Paints' },
      amountColumn: null,
      signConvention: 'debit_positive',
      statements: 0,
      isActive: true,
    });
    expect((await owner().post('/brand-statements/templates', template())).statusCode).toBe(409);
    const missing = await owner().post('/brand-statements/templates', {
      ...template(),
      name: 'No credit',
      creditColumn: null,
    });
    expect(missing.statusCode).toBe(400);
    const signed = ok(
      await owner().post('/brand-statements/templates', {
        ...template(),
        name: 'Signed',
        amountMode: 'signed',
        amountColumn: 'Amount',
      }),
    ).json<StatementTemplateView>();
    expect(signed).toMatchObject({ debitColumn: null, creditColumn: null, amountColumn: 'Amount' });
    expect(
      (
        await owner().post('/brand-statements/templates', {
          ...template(),
          name: 'Signed without column',
          amountMode: 'signed',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await owner().post('/brand-statements/templates', {
          ...template(),
          name: 'Not a supplier',
          supplierPartyId: biz.ownerMemberId,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await owner().post('/brand-statements/templates', {
          ...template(),
          name: 'No brand',
          brandId: biz.ownerMemberId,
        })
      ).statusCode,
    ).toBe(404);
    const changed = ok(
      await owner().put(`/brand-statements/templates/${signed.id}`, {
        ...template(),
        name: 'Signed, off',
        amountMode: 'signed',
        amountColumn: 'Amount',
        isActive: false,
      }),
    ).json<StatementTemplateView>();
    expect(changed).toMatchObject({ name: 'Signed, off', isActive: false });
    const otherSupplier = ok(
      await owner().post('/parties', {
        kind: 'organization',
        displayName: 'Other Distributors',
        roles: ['supplier'],
      }),
    ).json<{ id: string }>().id;
    expect(
      (
        await owner().put(`/brand-statements/templates/${signed.id}`, {
          ...template(),
          supplierPartyId: otherSupplier,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await owner().put(`/brand-statements/templates/${crypto.randomUUID()}`, template()))
        .statusCode,
    ).toBe(404);
    const listed = ok(await owner().get('/brand-statements/templates')).json<
      StatementTemplateView[]
    >();
    expect(listed.map((row) => row.name)).toEqual(['Deccan ledger', 'Signed, off']);
  });
});

describe('previewing a statement', () => {
  it('reads a CSV with the template and stores nothing', async () => {
    const reply = ok(await upload('/brand-statements/preview', { templateId }, julyFile()));
    const preview = reply.json<StatementPreview>();
    expect(preview).toMatchObject({
      fileName: 'July.csv',
      valid: true,
      errors: [],
      periodFrom: '2026-07-01',
      periodTo: '2026-07-30',
      openingBalancePaise: 10_000_00,
      debitsPaise: 67_250_00,
      creditsPaise: 52_000_00,
      duplicateOf: null,
    });
    expect(preview.lines.map((line) => line.kind)).toEqual([
      'opening',
      'invoice',
      'invoice',
      'invoice',
      'invoice',
      'credit_note',
      'credit_note',
      'payment',
    ]);
    expect(preview.skipped.map((row) => row.row)).toEqual([11]);
    expect(ok(await owner().get('/brand-statements')).json<unknown[]>()).toEqual([]);
  });

  it('reads the same statement saved from Excel', async () => {
    // Excel keeps dates as day numbers: 09-07-2026 is 46212.
    const rows = JULY.map((row, index) => (index === 3 ? [46_212, ...row.slice(1)] : row));
    const preview = ok(
      await upload(
        '/brand-statements/preview',
        { templateId },
        {
          fileName: 'July.xlsx',
          data: xlsxFile(rows),
        },
      ),
    ).json<StatementPreview>();
    expect(preview.valid).toBe(true);
    expect(preview.lines[1]).toMatchObject({ lineDate: '2026-07-09', documentNumber: 'AD/101' });
  });

  it('lists rows it cannot read, and refuses files it cannot open', async () => {
    const broken = ok(
      await upload(
        '/brand-statements/preview',
        { templateId },
        {
          fileName: 'bad.csv',
          data: csvFile([['x'], HEADER, ['31-02-2026', 'AD/1', '', '', '100', '']]),
        },
      ),
    ).json<StatementPreview>();
    expect(broken.valid).toBe(false);
    expect(broken.errors[0]).toMatchObject({ row: 3, column: 'Date' });
    const pdf = await upload(
      '/brand-statements/preview',
      { templateId },
      {
        fileName: 'July.pdf',
        data: Buffer.from('%PDF-1.4'),
      },
    );
    expect(pdf.statusCode).toBe(400);
    expect(pdf.json<{ code: string; message: string }>()).toMatchObject({ code: 'statement_file' });
    expect((await upload('/brand-statements/preview', { templateId }, null)).statusCode).toBe(400);
    expect(
      (await upload('/brand-statements/preview', { templateId: 'x' }, julyFile())).statusCode,
    ).toBe(400);
    expect(
      (await upload('/brand-statements/preview', { templateId: crypto.randomUUID() }, julyFile()))
        .statusCode,
    ).toBe(404);
    const plain = await owner().post('/brand-statements/preview', { templateId });
    expect(plain.statusCode).toBe(400);
    const garbled = await t.app.inject({
      method: 'POST',
      url: '/brand-statements/preview',
      headers: { ...bearer(biz.owner), 'content-type': 'multipart/form-data; boundary=x' },
      payload: '--x\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\n\r\nabc',
    });
    expect(garbled.statusCode).toBe(400);
    const huge = await upload(
      '/brand-statements/preview',
      { templateId },
      {
        fileName: 'huge.csv',
        data: Buffer.alloc(10 * 1024 * 1024 + 1, 0x41),
      },
    );
    expect(huge.statusCode).toBe(413);
  });
});

let statementId: string;

describe('importing and matching a statement', () => {
  it('stores the lines, matches them and explains the difference', async () => {
    const reply = ok(
      await upload('/brand-statements', { templateId, closingBalancePaise: '3525000' }, julyFile()),
    );
    expect(reply.statusCode).toBe(201);
    const detail = reply.json<BrandStatementDetail>();
    statementId = detail.statement.id;
    expect(detail.statement).toMatchObject({
      number: 'BS-000001',
      supplier: { id: biz.supplier },
      brand: { id: biz.brands.apex },
      periodFrom: '2026-07-01',
      periodTo: '2026-07-30',
      status: 'active',
      fileKept: false,
      lines: 7,
      mismatches: 3,
    });
    const status = (document: string | null, kind?: string) => {
      const line = lineOf(detail, document, kind);
      return [line.status, line.match?.source ?? null, line.match?.differencePaise ?? null];
    };
    expect(status('AD/101')).toEqual(['matched', 'auto', 0]);
    expect(status('AD/103')).toEqual(['partial', 'auto', 250_00]);
    expect(status('BG/201')).toEqual(['matched', 'auto', 0]);
    expect(status('AD/199')).toEqual(['unmatched', null, null]);
    expect(status('CN/7781')).toEqual(['matched', 'auto', 0]);
    expect(status('CN/7790')).toEqual(['unmatched', null, null]);
    expect(status('UTR555')).toEqual(['untracked', null, null]);
    expect(lineOf(detail, null, 'opening').status).toBe('unmatched');
    const ours = new Map(detail.ours.map((record) => [record.reference, record]));
    expect(ours.get('AD/102')).toMatchObject({
      inPeriod: false,
      lineId: null,
      amountPaise: 15_000_00,
    });
    expect(ours.get('AD/150')).toMatchObject({
      inPeriod: true,
      lineId: null,
      amountPaise: 2_000_00,
    });
    expect(ours.get('CN-7781')).toMatchObject({ kind: 'benefit_receipt', amountPaise: -1_200_00 });
    expect(ours.has('AD/104')).toBe(false);
    expect(detail.summary).toEqual({
      counts: { matched: 3, partial: 1, unmatched: 2, explained: 0, untracked: 1 },
      brandMovementPaise: 15_250_00,
      ourMovementPaise: 60_800_00,
      differencePaise: 15_250_00 - 60_800_00,
      amountDifferencesPaise: 250_00,
      unmatchedLinesPaise: 7_000_00 - 800_00,
      explainedLinesPaise: 0,
      untrackedLinesPaise: -50_000_00,
      ourUnmatchedPaise: 2_000_00,
      ourUnmatchedCount: 1,
      openingBalancePaise: 10_000_00,
      brandClosingPaise: 25_250_00,
      printedClosingPaise: 35_250_00,
    });
    const listed = ok(await owner().get('/brand-statements')).json<BrandStatementSummaryView[]>();
    expect(listed.map((row) => row.number)).toEqual(['BS-000001']);
  });

  it('refuses the same file again, and a second statement for the period', async () => {
    const again = await upload('/brand-statements', { templateId }, julyFile());
    expect(again.statusCode).toBe(409);
    expect(again.json<{ message: string }>().message).toBe(
      'This file is already imported as BS-000001',
    );
    const preview = ok(
      await upload('/brand-statements/preview', { templateId }, julyFile()),
    ).json<StatementPreview>();
    expect(preview.duplicateOf).toBe('BS-000001');
    const edited = csvFile([...JULY, ['30-07-2026', 'AD/200', 'Invoice', '', '1.00', '']]);
    const samePeriod = await upload(
      '/brand-statements',
      { templateId, periodFrom: '2026-07-01', periodTo: '2026-07-30' },
      { fileName: 'July v2.csv', data: edited },
    );
    expect(samePeriod.statusCode).toBe(409);
    expect(samePeriod.json<{ message: string }>().message).toMatch(/BS-000001 is this supplier/);
  });

  it('checks the period and the rows before importing anything', async () => {
    const outside = await upload(
      '/brand-statements',
      { templateId, periodFrom: '2026-07-05', periodTo: '2026-07-31' },
      { fileName: 'other.csv', data: ledger(['02-07-2026', 'X', '', '', '1', '']) },
    );
    expect(outside.statusCode).toBe(400);
    expect(outside.json<{ message: string }>().message).toBe(
      'Row 3 is dated 2026-07-02, outside the period',
    );
    const backwards = await upload(
      '/brand-statements',
      { templateId, periodFrom: '2026-08-31', periodTo: '2026-08-01' },
      julyFile(),
    );
    expect(backwards.statusCode).toBe(400);
    const afterLines = await upload(
      '/brand-statements',
      { templateId, periodFrom: '2026-08-31' },
      { fileName: 'early.csv', data: ledger(['02-07-2026', 'X', '', '', '1', '']) },
    );
    expect(afterLines.json<{ message: string }>().message).toBe('The period ends before it starts');
    const long = await upload(
      '/brand-statements',
      { templateId, periodFrom: '2025-07-01', periodTo: '2026-07-31' },
      { fileName: 'year.csv', data: ledger(['02-07-2026', 'X', '', '', '1', '']) },
    );
    expect(long.json<{ message: string }>().message).toBe('A statement covers at most a year');
    const rows = await upload(
      '/brand-statements',
      { templateId },
      {
        fileName: 'rows.csv',
        data: csvFile([['x'], HEADER, ['xx', 'X', '', '', '1', '']]),
      },
    );
    expect(rows.statusCode).toBe(400);
    expect(rows.json<{ code: string; preview: StatementPreview }>()).toMatchObject({
      code: 'statement_rows',
      preview: { valid: false },
    });
    const off = ok(await owner().get('/brand-statements/templates'))
      .json<StatementTemplateView[]>()
      .find((row) => !row.isActive);
    const switchedOff = await upload(
      '/brand-statements',
      { templateId: String(off?.id) },
      julyFile(),
    );
    expect(switchedOff.statusCode).toBe(409);
  });

  it('matches again to the same pairs: a run with nothing new changes nothing', async () => {
    const run = ok(
      await owner().post(`/brand-statements/${statementId}/match`),
    ).json<MatchRunResult>();
    expect(run).toMatchObject({ added: 0, removed: 0 });
    expect(run.detail.summary.counts.matched).toBe(3);
  });
});

describe("members' matches and explanations", () => {
  it('match a line by hand, unmatch it, and never see a rejected pair proposed again', async () => {
    const before = ok(
      await owner().get(`/brand-statements/${statementId}`),
    ).json<BrandStatementDetail>();
    const missing = lineOf(before, 'AD/199');
    const matched = ok(
      await owner().post(`/brand-statements/${statementId}/lines/${missing.id}/match`, {
        recordKey: `grn:${otherGrn}`,
        note: 'Brand billed AD/150 under another number',
      }),
    ).json<BrandStatementDetail>();
    expect(lineOf(matched, 'AD/199')).toMatchObject({
      status: 'partial',
      match: { source: 'manual', differencePaise: 5_000_00, by: 'Suma Owner' },
    });
    expect(
      (
        await owner().post(`/brand-statements/${statementId}/lines/${missing.id}/match`, {
          recordKey: `grn:${otherGrn}`,
          note: null,
        })
      ).statusCode,
    ).toBe(409);
    // A manual match survives a run.
    const run = ok(
      await owner().post(`/brand-statements/${statementId}/match`),
    ).json<MatchRunResult>();
    expect(lineOf(run.detail, 'AD/199').match?.source).toBe('manual');

    // Unmatching an automatic pair remembers it as rejected.
    const auto = lineOf(run.detail, 'AD/101');
    const unmatched = ok(
      await owner().delete(`/brand-statements/${statementId}/lines/${auto.id}/match`),
    ).json<BrandStatementDetail>();
    expect(lineOf(unmatched, 'AD/101')).toMatchObject({
      status: 'unmatched',
      rejected: [`grn:${biz.grns.g1}`],
    });
    const rerun = ok(
      await owner().post(`/brand-statements/${statementId}/match`),
    ).json<MatchRunResult>();
    expect(rerun.added).toBe(0);
    expect(lineOf(rerun.detail, 'AD/101').status).toBe('unmatched');
    // Matching it again by hand clears the rejection.
    const back = ok(
      await owner().post(`/brand-statements/${statementId}/lines/${auto.id}/match`, {
        recordKey: `grn:${biz.grns.g1}`,
        note: null,
      }),
    ).json<BrandStatementDetail>();
    expect(lineOf(back, 'AD/101')).toMatchObject({ status: 'matched', rejected: [] });
    // Scheme money is matched by hand the same way.
    const credit = lineOf(back, 'CN/7781');
    const receiptKey = String(credit.match?.recordKey);
    expect(receiptKey).toMatch(/^benefit_receipt:/);
    ok(await owner().delete(`/brand-statements/${statementId}/lines/${credit.id}/match`));
    const manual = ok(
      await owner().post(`/brand-statements/${statementId}/lines/${credit.id}/match`, {
        recordKey: receiptKey,
        note: null,
      }),
    ).json<BrandStatementDetail>();
    expect(lineOf(manual, 'CN/7781')).toMatchObject({
      status: 'matched',
      match: { source: 'manual', recordKey: receiptKey },
      rejected: [],
    });
  });

  it('refuse records that are not the statement’s and lines already settled', async () => {
    const detail = ok(
      await owner().get(`/brand-statements/${statementId}`),
    ).json<BrandStatementDetail>();
    const open = lineOf(detail, 'CN/7790');
    expect(
      (
        await owner().post(`/brand-statements/${statementId}/lines/${open.id}/match`, {
          recordKey: `grn:${crypto.randomUUID()}`,
          note: null,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await owner().post(`/brand-statements/${statementId}/lines/${open.id}/match`, {
          recordKey: 'nonsense',
          note: null,
        })
      ).statusCode,
    ).toBe(400);
    const opening = lineOf(detail, null, 'opening');
    expect(
      (
        await owner().post(`/brand-statements/${statementId}/lines/${opening.id}/explain`, {
          note: 'Brought forward',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await owner().post(
          `/brand-statements/${statementId}/lines/${crypto.randomUUID()}/explain`,
          {
            note: 'x',
          },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await owner().delete(`/brand-statements/${statementId}/lines/${open.id}/match`)).statusCode,
    ).toBe(404);
    // A GRN settling a line of this statement cannot settle another.
    expect(
      (
        await owner().post(`/brand-statements/${statementId}/lines/${open.id}/match`, {
          recordKey: `grn:${biz.grns.g1}`,
          note: null,
        })
      ).statusCode,
    ).toBe(409);
  });

  it('explain a line with a note, and take the explanation back', async () => {
    const detail = ok(
      await owner().get(`/brand-statements/${statementId}`),
    ).json<BrandStatementDetail>();
    const payment = lineOf(detail, 'UTR555');
    const explained = ok(
      await owner().post(`/brand-statements/${statementId}/lines/${payment.id}/explain`, {
        note: 'Paid by NEFT on 30 July',
      }),
    ).json<BrandStatementDetail>();
    expect(lineOf(explained, 'UTR555')).toMatchObject({
      status: 'explained',
      match: { source: 'explained', note: 'Paid by NEFT on 30 July', recordKey: null },
    });
    expect(explained.summary.explainedLinesPaise).toBe(-50_000_00);
    const back = ok(
      await owner().delete(`/brand-statements/${statementId}/lines/${payment.id}/match`),
    ).json<BrandStatementDetail>();
    expect(lineOf(back, 'UTR555')).toMatchObject({ status: 'untracked', rejected: [] });
  });
});

describe('a scheme credit note on the statement', () => {
  it('is never recorded from a line dated after today', async () => {
    const future = ok(
      await upload(
        '/brand-statements',
        { templateId },
        {
          fileName: 'Future.csv',
          data: ledger(['05-01-2030', 'CN/9', 'Credit Note', '', '', '10.00']),
        },
      ),
    ).json<BrandStatementDetail>();
    const reply = await owner().post(
      `/brand-statements/${future.statement.id}/lines/${lineOf(future, 'CN/9').id}/scheme-receipt`,
      { schemeId: monsoonId },
    );
    expect(reply.statusCode).toBe(400);
    expect(reply.json<{ message: string }>().message).toBe('This line is dated in the future');
    ok(await owner().post(`/brand-statements/${future.statement.id}/discard`));
  });

  it('is recorded against its scheme and matched in one step', async () => {
    const detail = ok(
      await owner().get(`/brand-statements/${statementId}`),
    ).json<BrandStatementDetail>();
    const credit = lineOf(detail, 'CN/7790');
    const debit = lineOf(detail, 'AD/103');
    expect(
      (
        await owner().post(`/brand-statements/${statementId}/lines/${credit.id}/scheme-receipt`, {
          schemeId: crypto.randomUUID(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await owner().post(`/brand-statements/${statementId}/lines/${credit.id}/scheme-receipt`, {
          schemeId: monsoonId,
          claimId: crypto.randomUUID(),
        })
      ).statusCode,
    ).toBe(404);
    const draft = ok(
      await owner().post('/brand-schemes', {
        brandId: biz.brands.apex,
        name: 'Draft scheme',
        startsOn: '2026-07-01',
        endsOn: '2026-09-30',
        measure: 'value',
        slabs: [{ target: 1_00, benefits: [{ kind: 'rebate', basisPoints: 100 }] }],
      }),
    ).json<SchemeView>();
    expect(
      (
        await owner().post(`/brand-statements/${statementId}/lines/${credit.id}/scheme-receipt`, {
          schemeId: draft.id,
        })
      ).statusCode,
    ).toBe(409);
    const unmatchDebit = ok(
      await owner().delete(`/brand-statements/${statementId}/lines/${debit.id}/match`),
    ).json<BrandStatementDetail>();
    expect(lineOf(unmatchDebit, 'AD/103').status).toBe('unmatched');
    expect(
      (
        await owner().post(`/brand-statements/${statementId}/lines/${debit.id}/scheme-receipt`, {
          schemeId: monsoonId,
        })
      ).statusCode,
    ).toBe(400);
    const recorded = ok(
      await owner().post(`/brand-statements/${statementId}/lines/${credit.id}/scheme-receipt`, {
        schemeId: monsoonId,
        claimId: null,
        note: null,
      }),
    ).json<BrandStatementDetail>();
    const line = lineOf(recorded, 'CN/7790');
    expect(line).toMatchObject({
      status: 'matched',
      match: { source: 'manual', differencePaise: 0 },
    });
    const receipt = recorded.ours.find((record) => record.key === line.match?.recordKey);
    expect(receipt).toMatchObject({
      reference: 'CN/7790',
      amountPaise: -800_00,
      schemeId: monsoonId,
    });
    const scheme = ok(
      await owner().get(`/brand-schemes/${monsoonId}?asOf=2026-08-01`),
    ).json<SchemeDetail>();
    expect(scheme.claim.money.receivedPaise).toBe(2_000_00);
    expect(scheme.receipts.map((row) => row.reference)).toContain('CN/7790');
    // A credit with no document number is recorded with no reference.
    const unnamed = ok(
      await upload(
        '/brand-statements',
        { templateId },
        {
          fileName: 'Unnamed CN.csv',
          data: ledger(['10-09-2026', '', 'Credit Note', '', '', '5.00']),
        },
      ),
    ).json<BrandStatementDetail>();
    const recordedUnnamed = ok(
      await owner().post(
        `/brand-statements/${unnamed.statement.id}/lines/${lineOf(unnamed, null).id}/scheme-receipt`,
        { schemeId: monsoonId, note: 'Scheme top-up' },
      ),
    ).json<BrandStatementDetail>();
    const unnamedKey = lineOf(recordedUnnamed, null).match?.recordKey;
    expect(recordedUnnamed.ours.find((record) => record.key === unnamedKey)?.reference).toBeNull();
    ok(await owner().post(`/brand-statements/${unnamed.statement.id}/discard`));
  });
});

describe('the mismatch list', () => {
  it('downloads as CSV with the brand-only lines, the differences and our-only records', async () => {
    const reply = ok(await owner().get(`/brand-statements/${statementId}/mismatches.csv`));
    expect(reply.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(reply.headers['content-disposition']).toContain('BS-000001-mismatches.csv');
    const lines = reply.body.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe(
      'Side,Status,Date,Document,Kind,Reference,Description,Amount,Our record,Our amount,Difference,Note',
    );
    expect(lines).toContain('Brand,unmatched,2026-07-15,AD/103,invoice,,Wall Putty,5250.00,,,,');
    expect(lines).toContain(
      'Brand,partial,2026-07-22,AD/199,invoice,,Not received,7000.00,GRN-000006,2000.00,5000.00,Brand billed AD/150 under another number',
    );
    expect(lines).toContain('Brand,untracked,2026-07-30,UTR555,payment,,Thank you,-50000.00,,,,');
    expect(lines.some((line) => line.startsWith('Ours,unmatched,2026-07-15,GRN-'))).toBe(true);
    expect(lines.at(-2)).toMatch(/^Difference,,,,,,,-/);
    expect(lines.at(-1)).toBe('');
  });
});

describe('discarding a statement', () => {
  it('frees its period and records, and refuses changes after', async () => {
    const discarded = ok(
      await owner().post(`/brand-statements/${statementId}/discard`),
    ).json<BrandStatementSummaryView>();
    expect(discarded.status).toBe('discarded');
    expect((await owner().post(`/brand-statements/${statementId}/match`)).statusCode).toBe(409);
    expect((await owner().post(`/brand-statements/${statementId}/discard`)).statusCode).toBe(409);
    expect(ok(await owner().get('/brand-statements')).json<unknown[]>()).toEqual([]);
    const old = ok(await owner().get('/brand-statements?status=discarded')).json<
      BrandStatementSummaryView[]
    >();
    expect(old.map((row) => row.number)).toEqual(['BS-000002', 'BS-000003', 'BS-000001']);
    const detail = ok(
      await owner().get(`/brand-statements/${statementId}`),
    ).json<BrandStatementDetail>();
    expect(detail.lines.every((line) => line.match === null)).toBe(true);
    // The same file imports again, and GRNs match afresh.
    const again = ok(
      await upload('/brand-statements', { templateId }, julyFile()),
    ).json<BrandStatementDetail>();
    expect(again.statement.number).toBe('BS-000004');
    expect(lineOf(again, 'AD/101').status).toBe('matched');
    expect(
      ok(await owner().get(`/brand-statements?supplierPartyId=${biz.supplier}`)).json<unknown[]>(),
    ).toHaveLength(1);
    expect((await owner().get(`/brand-statements/${crypto.randomUUID()}`)).statusCode).toBe(404);
    expect((await owner().get(`/brand-statements/${statementId}/file`)).statusCode).toBe(404);
  });

  it('a GRN settled on one statement is not matched on another', async () => {
    const august = ok(
      await upload(
        '/brand-statements',
        { templateId },
        {
          fileName: 'Repeat.csv',
          data: ledger(
            ['10-07-2026', 'AD/101', 'Invoice', '', '40,000.00', ''],
            ['11-07-2026', 'X', '', '', '1', ''],
          ),
        },
      ),
    );
    expect(august.statusCode).toBe(201);
    const detail = august.json<BrandStatementDetail>();
    expect(lineOf(detail, 'AD/101').status).toBe('unmatched');
    expect(detail.ours.find((record) => record.reference === 'AD/101')?.elsewhere).toBe(true);
  });
});

describe('a supplier with no brand on its template', () => {
  it('matches GRNs only, and lists lines without a number in the mismatches', async () => {
    const plain = ok(
      await owner().post('/parties', {
        kind: 'organization',
        displayName: 'Plain Distributors',
        roles: ['supplier'],
      }),
    ).json<{ id: string }>().id;
    const noBrand = ok(
      await owner().post('/brand-statements/templates', {
        ...template(),
        name: 'Plain ledger',
        supplierPartyId: plain,
        brandId: null,
      }),
    ).json<StatementTemplateView>();
    expect(noBrand.brand).toBeNull();
    const detail = ok(
      await upload(
        '/brand-statements',
        { templateId: noBrand.id, closingBalancePaise: '' },
        {
          fileName: 'Plain.csv',
          data: ledger(['12-09-2026', '', '', '', '99.00', '']),
        },
      ),
    ).json<BrandStatementDetail>();
    expect(detail.statement.brand).toBeNull();
    expect(detail.ours).toEqual([]);
    expect(detail.summary.printedClosingPaise).toBeNull();
    const csv = ok(await owner().get(`/brand-statements/${detail.statement.id}/mismatches.csv`));
    expect(csv.body).toContain('Brand,unmatched,2026-09-12,,invoice,,,99.00,,,,');
  });
});

describe('merging suppliers', () => {
  it('never merges away a supplier with brand statements', async () => {
    const keep = ok(
      await owner().post('/parties', {
        kind: 'organization',
        displayName: 'Deccan Distributors Pvt Ltd',
        roles: ['supplier'],
      }),
    ).json<{ id: string }>().id;
    const reply = await owner().post(`/parties/${biz.supplier}/merge`, { intoPartyId: keep });
    expect(reply.statusCode).toBe(409);
    expect(reply.json<{ message: string }>().message).toBe(
      'This supplier has brand statements; merge the other way',
    );
  });
});

describe('with GST', () => {
  it('compares GRNs at their value with GST at their products’ rates', async () => {
    const gst = ok(
      await owner().post('/brand-statements/templates', {
        ...template(),
        name: 'With GST',
        grnAmountBasis: 'with_gst',
      }),
    ).json<StatementTemplateView>();
    // The rate in force on the day for the product's tax category, else the product's own.
    const rows = await t.connection.db.execute<{ rate: number }>(sql`
      select coalesce(r.rate_bps, p.gst_rate_bps) as rate from products p
      left join tax_rates r on r.tax_category_id = p.tax_category_id
        and '2026-10-02' between r.effective_from and coalesce(r.effective_to, '2026-10-02')
      where p.id = ${biz.products.ultima}`);
    const rate = Number(rows.rows[0]?.rate);
    const statement = ok(
      await upload(
        '/brand-statements',
        { templateId: gst.id, periodFrom: '2026-10-01', periodTo: '2026-10-31' },
        {
          fileName: 'October.csv',
          data: ledger(['02-10-2026', 'AD/104', 'Invoice', '', '1', '']),
        },
      ),
    ).json<BrandStatementDetail>();
    const record = statement.ours.find((row) => row.reference === 'AD/104');
    expect(record?.amountPaise).toBe(5_000_00 + Math.round((5_000_00 * rate) / 10_000));
  });
});

describe('pairs the run made earlier', () => {
  it('move to a better record when one arrives, and nothing else changes', async () => {
    const receive = async (reference: string, day: string) =>
      ok(
        await owner().post('/goods-receipts', {
          storeId: biz.stores.hyd,
          supplierId: biz.supplier,
          supplierInvoiceNumber: reference,
          supplierInvoiceDate: day,
          lines: [{ variantId: biz.variants.ultima10, quantity: 1, unitCostPaise: 1_000_00 }],
        }),
      ).json<{ id: string; number: string }>();
    // Another invoice number of the distributor's: matched by date and amount only.
    const near = await receive('DD/0805', '2026-08-05');
    const statement = ok(
      await upload(
        '/brand-statements',
        { templateId },
        {
          fileName: 'August.csv',
          data: ledger(['06-08-2026', 'AD/800', 'Invoice', '', '1,000.00', '']),
        },
      ),
    ).json<BrandStatementDetail>();
    expect(lineOf(statement, 'AD/800').match?.recordKey).toBe(`grn:${near.id}`);
    const named = await receive('AD/800', '2026-08-10');
    const run = ok(
      await owner().post(`/brand-statements/${statement.statement.id}/match`),
    ).json<MatchRunResult>();
    expect(run).toMatchObject({ added: 1, removed: 1 });
    expect(lineOf(run.detail, 'AD/800').match?.recordKey).toBe(`grn:${named.id}`);
  });
});

describe('keeping the original file', () => {
  let stored: TestApp;
  let downScanner: TestApp;
  let downStorage: TestApp;

  beforeAll(async () => {
    const env = await testBucket(
      inject('objectStorageEndpoint'),
      inject('virusScannerAddress'),
      `statements-${crypto.randomUUID().slice(0, 8)}`,
    );
    stored = await startTestApp(database.connectionString, env);
    downScanner = await startTestApp(database.connectionString, { ...env, CLAMAV_PORT: '9' });
    downStorage = await startTestApp(database.connectionString, {
      ...env,
      STORAGE_ENDPOINT: 'http://127.0.0.1:9',
    });
  }, 120_000);

  afterAll(async () => {
    await stored.close();
    await downScanner.close();
    await downStorage.close();
  });

  it('keeps a clean file to download, refuses a virus, and imports without the file when the scanner is down', async () => {
    const september = ledger(['05-09-2026', 'AD/300', 'Invoice', '', '10.00', '']);
    const kept = await upload(
      '/brand-statements',
      { templateId },
      { fileName: 'September.csv', data: september },
      stored,
    );
    expect(kept.statusCode).toBe(201);
    const detail = kept.json<BrandStatementDetail>();
    expect(detail.statement.fileKept).toBe(true);
    const file = await stored.app.inject({
      method: 'GET',
      url: `/brand-statements/${detail.statement.id}/file`,
      headers: bearer(biz.owner),
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-disposition']).toContain('September.csv');
    expect(file.rawPayload.equals(september)).toBe(true);

    const virus = await upload(
      '/brand-statements',
      { templateId },
      // Scanned before it is read: the test virus refuses the import.
      { fileName: 'October.csv', data: EICAR },
      stored,
    );
    expect(virus.statusCode).toBe(422);

    const down = await upload(
      '/brand-statements',
      { templateId },
      { fileName: 'November.csv', data: ledger(['05-11-2026', 'A', '', '', '1', '']) },
      downScanner,
    );
    expect(down.statusCode).toBe(201);
    expect(down.json<BrandStatementDetail>().statement.fileKept).toBe(false);

    const noStorage = await upload(
      '/brand-statements',
      { templateId },
      { fileName: 'December.csv', data: ledger(['05-12-2026', 'A', '', '', '1', '']) },
      downStorage,
    );
    expect(noStorage.statusCode).toBe(201);
    expect(noStorage.json<BrandStatementDetail>().statement.fileKept).toBe(false);
  });
});
