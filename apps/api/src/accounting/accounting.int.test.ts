import { migrateDatabase } from '@paint/db';
import type {
  AccountingExportPage,
  AccountingExportPreview,
  IssuedInvoiceView,
  LedgerMappingView,
  PaymentView,
  TaxDocumentView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  dbToday,
  issuesOf,
  ok,
  type BillingBusiness,
  type Reply,
} from '../test-support/billing-business.js';
import { testBucket } from '../test-support/files.js';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let today: string;
let env: Record<string, string>;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  env = await testBucket(
    inject('objectStorageEndpoint'),
    inject('virusScannerAddress'),
    'accounting-test',
  );
  t = await startTestApp(database.connectionString, env);
  b = await billingBusiness(t);
  today = await dbToday(t);
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

const owner = () => api(t, b.owner);
const ALL = 'sales,credit_note,debit_note,receipt';
const preview = async (kinds = ALL, token = b.owner) =>
  ok(
    await api(t, token).get(`/accounting-exports/preview?from=${today}&to=${today}&kinds=${kinds}`),
  ).json<AccountingExportPreview>();
const exportFile = (body: object = {}, app = t) =>
  api(app, b.owner).post('/accounting-exports', {
    from: today,
    to: today,
    kinds: ['sales', 'credit_note', 'debit_note', 'receipt'],
    format: 'tally_xml',
    ...body,
  });
const lineOf = (invoice: TaxDocumentView) => String(invoice.lines[0]?.id);
const pay = async (body: object) =>
  ok(
    await owner().post('/payments', {
      storeId: b.stores.amp,
      partyId: b.parties.contractor,
      amountPaise: 1_000,
      ...body,
    }),
  ).json<PaymentView>();
const mapping = (body: object) => owner().post('/ledger-mappings', body);

describe('the Tally export', () => {
  let invoice: IssuedInvoiceView;
  let receiptId: string;

  it('has nothing to export before anything is billed', async () => {
    expect(await preview()).toEqual({
      from: today,
      to: today,
      companyName: 'Rangoli Paints Private Limited',
      counts: { sales: 0, credit_note: 0, debit_note: 0, receipt: 0 },
      problems: [],
      withReceipts: { refunds: 0, bouncedCheques: 0 },
    });
    const empty = await exportFile();
    expect(empty.statusCode).toBe(422);
    expect(issuesOf(empty)).toEqual(['from']);
  });

  it('previews a day of invoices, notes and receipts, and refuses while a ledger is unmapped', async () => {
    invoice = await b.invoice({ partyId: b.parties.contractor, quantity: 2 });
    // A walk-in sale paid by UPI at the counter: Cash Sales, and its receipt.
    await b.invoice({
      issue: { payments: [{ modeId: b.modes.upi.id, amountPaise: 11_800 }] },
    });
    await b.invoice({ partyId: b.parties.homeowner, storeId: b.stores.kkp });
    ok(
      await owner().post('/credit-notes', {
        invoiceId: invoice.id,
        reason: 'overcharge',
        lines: [{ invoiceLineId: lineOf(invoice), valuePaise: 1_180 }],
      }),
    );
    ok(
      await owner().post('/debit-notes', {
        invoiceId: invoice.id,
        lines: [{ invoiceLineId: lineOf(invoice), valuePaise: 590 }],
      }),
    );
    receiptId = (
      await pay({
        modeId: b.modes.bank.id,
        reference: 'UTR123',
        allocations: [{ documentId: invoice.id, amountPaise: 1_000 }],
      })
    ).id;
    // Money that goes with the receipts: a refund (Payment) and a bounced cheque (Journal).
    const advance = await pay({ modeId: b.modes.upi.id, amountPaise: 5_000, allocations: [] });
    ok(
      await owner().post(`/payments/${advance.id}/refund`, {
        modeId: b.modes.upi.id,
        amountPaise: 1_000,
      }),
    );
    const cheque = await pay({
      partyId: b.parties.homeowner,
      modeId: b.modes.cheque.id,
      reference: '004512',
      chequeDate: today,
      allocations: [],
    });
    ok(await owner().post(`/payments/${cheque.id}/bounce`, { reason: 'Funds' }));

    const seen = await preview();
    // The bounced cheque is still a receipt: its bounce reverses it.
    expect(seen.counts).toEqual({ sales: 3, credit_note: 1, debit_note: 1, receipt: 4 });
    expect(seen.withReceipts).toEqual({ refunds: 1, bouncedCheques: 1 });
    expect(seen.problems.map((problem) => problem.code)).toEqual(['unmapped_ledger']);
    expect(seen.problems[0]?.message).toContain('Bank transfer');

    const refused = await exportFile();
    expect(refused.statusCode).toBe(422);
    expect(issuesOf(refused)).toEqual(['unmapped_ledger']);
    const salesOnly = await preview('sales');
    expect(salesOnly.counts).toEqual({ sales: 3, credit_note: 0, debit_note: 0, receipt: 0 });
    expect(salesOnly.withReceipts).toEqual({ refunds: 0, bouncedCheques: 0 });
    expect((await preview('receipt')).counts.receipt).toBe(4);
  });

  it('keeps ledger mappings: checked, replaced and removed', async () => {
    const refused = await mapping({ purpose: 'party', rateBasisPoints: 1800, ledgerName: 'X' });
    expect(refused.statusCode).toBe(400);
    expect(issuesOf(refused)).toEqual(['rateBasisPoints']);
    const strangers = await mapping({
      purpose: 'payment_mode',
      storeId: crypto.randomUUID(),
      modeId: crypto.randomUUID(),
      ledgerName: 'HDFC Bank',
    });
    expect(strangers.statusCode).toBe(422);
    expect(issuesOf(strangers)).toEqual(['storeId', 'modeId']);
    expect(
      issuesOf(await mapping({ purpose: 'party', partyId: crypto.randomUUID(), ledgerName: 'X' })),
    ).toEqual(['partyId']);

    const bank = ok(
      await mapping({
        purpose: 'payment_mode',
        modeId: b.modes.bank.id,
        storeId: b.stores.amp,
        ledgerName: 'HDFC Bank',
        group: 'Bank Accounts',
      }),
    ).json<LedgerMappingView>();
    expect(bank).toMatchObject({
      purpose: 'payment_mode',
      modeId: b.modes.bank.id,
      storeId: b.stores.amp,
      ledgerName: 'HDFC Bank',
      group: 'Bank Accounts',
      position: 0,
      partyName: null,
    });
    const sales = ok(
      await mapping({
        purpose: 'sales',
        rateBasisPoints: 1800,
        nature: 'taxable',
        supplyType: 'intra_state',
        storeId: b.stores.kkp,
        ledgerName: 'Sales KKP 18%',
      }),
    ).json<LedgerMappingView>();
    const party = ok(
      await mapping({
        purpose: 'party',
        partyId: b.parties.contractor,
        ledgerName: 'Deccan Contractors (Hyd)',
        position: 1,
      }),
    ).json<LedgerMappingView>();
    expect(party.partyName).toBe('Deccan Contractors');

    // Replacing clears the match columns left out.
    const everywhere = ok(
      await owner().put(`/ledger-mappings/${sales.id}`, {
        purpose: 'sales',
        rateBasisPoints: 1800,
        ledgerName: 'Sales GST 18%',
      }),
    ).json<LedgerMappingView>();
    expect(everywhere).toMatchObject({ storeId: null, supplyType: null, nature: null });
    const missing = crypto.randomUUID();
    expect(
      (await owner().put(`/ledger-mappings/${missing}`, { purpose: 'round_off', ledgerName: 'R' }))
        .statusCode,
    ).toBe(404);

    const remove = (id: string) =>
      t.app.inject({ method: 'DELETE', url: `/ledger-mappings/${id}`, headers: bearer(b.owner) });
    expect((await remove(party.id)).statusCode).toBe(204);
    expect((await remove(party.id)).statusCode).toBe(404);

    // A bounced cheque's charges have a ledger of their own, per store at most.
    expect(
      issuesOf(
        await mapping({ purpose: 'bounce_charges', modeId: b.modes.bank.id, ledgerName: 'X' }),
      ),
    ).toEqual(['modeId']);
    const bounce = ok(
      await mapping({
        purpose: 'bounce_charges',
        storeId: b.stores.amp,
        ledgerName: 'Bounce charges',
      }),
    ).json<LedgerMappingView>();
    expect(bounce).toMatchObject({ purpose: 'bounce_charges', storeId: b.stores.amp });
    expect((await remove(bounce.id)).statusCode).toBe(204);

    const list = ok(await owner().get('/ledger-mappings')).json<LedgerMappingView[]>();
    expect(list.map((row) => [row.purpose, row.ledgerName])).toEqual([
      ['sales', 'Sales GST 18%'],
      ['payment_mode', 'HDFC Bank'],
    ]);
  });

  it('exports Tally XML, records it and files the zip', async () => {
    expect((await preview()).problems).toEqual([]);
    const reply = ok(await exportFile());
    expect(reply.headers['content-type']).toBe('application/zip');
    expect(reply.headers['content-disposition']).toContain(`tally-${today}-to-${today}.zip`);
    const zip = reply.rawPayload.toString('utf8');
    expect(zip).toContain('1-masters.xml');
    expect(zip).toContain('HDFC Bank');
    expect(zip).toContain('Sales GST 18%');
    expect(zip).toContain(`[paint:${receiptId}]`);
    expect(zip).toContain('Cash Sales');
    const id = String(reply.headers['x-accounting-export-id']);

    const xlsx = ok(await exportFile({ format: 'xlsx', kinds: ['receipt'], companyName: 'RP' }));
    expect(xlsx.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    const history = ok(await owner().get('/accounting-exports')).json<AccountingExportPage>();
    expect(history.total).toBe(2);
    expect(history.items.map((row) => [row.format, row.kinds, row.voucherCount])).toEqual([
      ['xlsx', ['receipt'], 6],
      ['tally_xml', ['sales', 'credit_note', 'debit_note', 'receipt'], 11],
    ]);
    const filed = history.items[1];
    expect(filed).toMatchObject({ id, periodFrom: today, periodTo: today, createdBy: 'Owner' });
    const download = ok(await owner().get(`/documents/${String(filed?.documentId)}/download`));
    expect(download.rawPayload.equals(reply.rawPayload)).toBe(true);
    expect(
      ok(await owner().get('/accounting-exports?limit=1&offset=1')).json<AccountingExportPage>()
        .items[0]?.id,
    ).toBe(id);
  });

  it('prints a payment receipt as a PDF', async () => {
    const reply = ok(await owner().get(`/payments/${receiptId}/receipt.pdf`));
    expect(reply.headers['content-type']).toBe('application/pdf');
    expect(reply.headers['content-disposition']).toContain('.pdf');
    expect(reply.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await owner().get(`/payments/${crypto.randomUUID()}/receipt.pdf`)).statusCode).toBe(
      404,
    );
  });

  it('keeps a member to the stores they work at', async () => {
    const role = ok(
      await owner().post('/roles', {
        name: 'Accountant (Ameerpet)',
        permissions: ['accounting:export'],
      }),
    ).json<{ id: string }>();
    const phone = uniquePhone();
    ok(
      await owner().post('/members', {
        fullName: 'Accountant',
        phone,
        password: 'Staff@2026',
        roleId: role.id,
        storeIds: [b.stores.amp],
      }),
    );
    const login = await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { identifier: phone, password: 'Staff@2026' },
    });
    const accountant = login.json<{ token: string }>().token;
    expect((await preview(ALL, accountant)).counts).toEqual({
      sales: 2,
      credit_note: 1,
      debit_note: 1,
      receipt: 4,
    });
  });

  it('is for members who may export the books', async () => {
    const manager = await b.member('branch_manager', [b.stores.amp]);
    const statuses = await Promise.all([
      api(t, manager).get('/ledger-mappings'),
      api(t, manager).get('/accounting-exports'),
      api(t, manager).post('/accounting-exports', {}),
      api(t, manager).post('/ledger-mappings', {}),
    ]);
    expect(statuses.map((reply: Reply) => reply.statusCode)).toEqual([403, 403, 403, 403]);
  });

  it('exports a refund as a Payment voucher and a bounced cheque as its receipt plus a Journal', async () => {
    /** One voucher of the export, by its REMOTEID. */
    const voucher = (zip: string, remoteId: string) =>
      zip.slice(zip.indexOf(`REMOTEID="paint-${remoteId}"`)).split('</VOUCHER>')[0] ?? '';
    const invoiced = await b.invoice({ partyId: b.parties.homeowner, quantity: 1 });
    const invoiceNumber = String(invoiced.number);
    // A cheque for part of the bill: allocated, undone, allocated again for more, then bounced.
    const cheque = await pay({
      partyId: b.parties.homeowner,
      modeId: b.modes.cheque.id,
      reference: '771100',
      chequeDate: today,
      amountPaise: 2_000,
      allocations: [{ documentId: invoiced.id, amountPaise: 1_000 }],
    });
    ok(
      await owner().post(
        `/payments/${cheque.id}/allocations/${String(cheque.allocations[0]?.id)}/reverse`,
      ),
    );
    ok(
      await owner().post(`/payments/${cheque.id}/allocate`, {
        allocations: [{ documentId: invoiced.id, amountPaise: 1_500 }],
      }),
    );
    ok(
      await owner().post(`/payments/${cheque.id}/bounce`, {
        reason: 'Signature differs',
        chargePaise: 500,
      }),
    );
    // An advance with its receipt voucher, part of it paid back.
    const advance = await pay({ modeId: b.modes.upi.id, amountPaise: 3_000, allocations: [] });
    const refund = ok(
      await owner().post(`/payments/${advance.id}/refund`, {
        modeId: b.modes.upi.id,
        amountPaise: 700,
      }),
    ).json<PaymentView>();

    const zip = ok(await exportFile({ kinds: ['receipt'] })).rawPayload.toString('utf8');
    /** A bill-wise line, however deep it is indented. */
    const bill = (name: string, type: string, amount: string) =>
      new RegExp(
        `<NAME>${name}</NAME>\\s*<BILLTYPE>${type}</BILLTYPE>\\s*<AMOUNT>${amount}</AMOUNT>`,
      );
    // Part of the cheque was left over, so it took a receipt voucher number (an advance).
    const number = String(cheque.voucherNumber);
    // The receipt as it was when it bounced: ₹15 against the bill, ₹5 as its advance.
    const receipt = voucher(zip, cheque.id);
    expect(receipt).toContain('VCHTYPE="Receipt"');
    expect(receipt).toMatch(bill(invoiceNumber, 'Agst Ref', '15.00'));
    expect(receipt).toMatch(bill(number, 'Advance', '5.00'));
    // The allocation undone before the bounce is not part of it.
    expect(receipt).not.toContain('<AMOUNT>10.00</AMOUNT>');
    // Its bounce reopens that bill and the advance, and bills the ₹5 charge.
    const bounce = voucher(zip, `${cheque.id}-bounce`);
    expect(bounce).toContain('VCHTYPE="Journal"');
    expect(bounce).toContain(`<VOUCHERNUMBER>${number}/BOUNCE</VOUCHERNUMBER>`);
    expect(bounce).toContain(`<REFERENCE>${number}</REFERENCE>`);
    expect(bounce).toContain('Signature differs; bounce charge Rs 5.00');
    expect(bounce).toContain('<AMOUNT>-25.00</AMOUNT>');
    expect(bounce).toMatch(bill(invoiceNumber, 'Agst Ref', '-15.00'));
    expect(bounce).toMatch(bill(number, 'Agst Ref', '-5.00'));
    expect(bounce).toMatch(bill(`${number}/BOUNCE`, 'New Ref', '-5.00'));
    expect(bounce).toContain('<LEDGERNAME>Cheques in Hand</LEDGERNAME>');
    expect(bounce).toContain('<LEDGERNAME>Cheque Bounce Charges</LEDGERNAME>');
    expect(zip).toContain('<PARENT>Indirect Incomes</PARENT>');
    // The refund pays the advance back under its refund voucher number, against the advance.
    const payment = voucher(zip, refund.id);
    expect(payment).toContain('VCHTYPE="Payment"');
    expect(payment).toContain(`<VOUCHERNUMBER>${String(refund.voucherNumber)}</VOUCHERNUMBER>`);
    expect(payment).toMatch(bill(String(advance.voucherNumber), 'Agst Ref', '-7.00'));
    expect(payment).toContain('<LEDGERNAME>UPI Clearing</LEDGERNAME>');

    // A cheque taken yesterday that bounced today: today's export holds only its reversal.
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const earlier = await pay({
      partyId: b.parties.homeowner,
      modeId: b.modes.cheque.id,
      reference: '771101',
      chequeDate: yesterday,
      receivedOn: yesterday,
      allocations: [],
    });
    ok(
      await owner().post(`/payments/${earlier.id}/bounce`, {
        reason: 'Account closed',
        chargePaise: 300,
      }),
    );
    // Bounce charges map from settings like any other ledger.
    ok(
      await mapping({
        purpose: 'bounce_charges',
        storeId: b.stores.amp,
        ledgerName: 'Bank Charges Recovered',
      }),
    );
    const alone = ok(await exportFile({ kinds: ['receipt'] })).rawPayload.toString('utf8');
    expect(alone).toContain('<LEDGERNAME>Bank Charges Recovered</LEDGERNAME>');
    expect(alone).not.toContain('Cheque Bounce Charges');
    expect(alone).not.toContain(`REMOTEID="paint-${earlier.id}"`);
    expect(voucher(alone, `${earlier.id}-bounce`)).toContain(
      `<REFERENCEDATE>${yesterday.replaceAll('-', '')}</REFERENCEDATE>`,
    );
  });

  it('checks the period and the kinds', async () => {
    const query = (search: string) => owner().get(`/accounting-exports/preview?${search}`);
    expect(issuesOf(await query(`from=${today}&to=2020-01-01&kinds=sales`))).toEqual(['to']);
    expect(issuesOf(await query(`from=${today}&to=${today}&kinds=sales,sales`))).toEqual(['kinds']);
    expect(issuesOf(await query(`from=${today}&to=${today}&kinds=purchases`))).toEqual(['kinds.0']);
    expect(issuesOf(await exportFile({ kinds: ['sales', 'sales'], to: '2020-01-01' }))).toEqual([
      'kinds',
      'to',
    ]);
  });
});

describe('without working file storage', () => {
  it('still exports, keeping no copy of the file', async () => {
    const without = await startTestApp(database.connectionString);
    const down = await startTestApp(database.connectionString, {
      ...env,
      STORAGE_ENDPOINT: 'http://127.0.0.1:1',
    });
    try {
      ok(await exportFile({ kinds: ['sales'] }, without));
      ok(await exportFile({ kinds: ['receipt'], format: 'xlsx' }, down));
      const history = ok(await owner().get('/accounting-exports')).json<AccountingExportPage>();
      expect(history.items.slice(0, 2).map((row) => [row.kinds, row.documentId])).toEqual([
        [['receipt'], null],
        [['sales'], null],
      ]);
    } finally {
      await without.close();
      await down.close();
    }
  });
});
