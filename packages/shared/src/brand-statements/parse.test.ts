import { describe, expect, it } from 'vitest';
import type { StatementLayout } from './api.js';
import {
  classifyLine,
  normalizeHeader,
  normalizeReference,
  parseStatementAmount,
  parseStatementDate,
  parseStatementRows,
} from './parse.js';

const layout: StatementLayout = {
  headerRowsToSkip: 0,
  dateColumn: 'Date',
  documentColumn: 'Doc No',
  typeColumn: 'Type',
  referenceColumn: 'Ref',
  descriptionColumn: 'Narration',
  amountMode: 'debit_credit',
  debitColumn: 'Debit',
  creditColumn: 'Credit',
  amountColumn: null,
  signConvention: 'debit_positive',
  dateFormat: 'dd-mm-yyyy',
  typeRules: {
    invoice: ['INV'],
    credit_note: ['CN', 'Credit Note'],
    payment: ['RCPT'],
    opening: ['Opening'],
  },
};

describe('normalizeHeader and normalizeReference', () => {
  it('compare headers without case or spacing, and references without punctuation', () => {
    expect(normalizeHeader('  Doc   No ')).toBe('doc no');
    expect(normalizeReference('inv/0881-a')).toBe('INV0881A');
    expect(normalizeReference(null)).toBe('');
  });
});

describe('parseStatementDate', () => {
  it('reads each format, two-digit years and a time after the date', () => {
    expect(parseStatementDate('05-09-2026', 'dd-mm-yyyy')).toBe('2026-09-05');
    expect(parseStatementDate('5/9/26', 'dd-mm-yyyy')).toBe('2026-09-05');
    expect(parseStatementDate('05.09.2026 10:30', 'dd-mm-yyyy')).toBe('2026-09-05');
    expect(parseStatementDate('09/05/2026', 'mm-dd-yyyy')).toBe('2026-09-05');
    expect(parseStatementDate('2026-09-05', 'yyyy-mm-dd')).toBe('2026-09-05');
    expect(parseStatementDate('2026/9/5T00:00:00', 'yyyy-mm-dd')).toBe('2026-09-05');
    expect(parseStatementDate('05-Sep-2026', 'dd-mon-yyyy')).toBe('2026-09-05');
    expect(parseStatementDate('5 September, 26', 'dd-mon-yyyy')).toBe('2026-09-05');
    expect(parseStatementDate('5 Sep 2026 9:15 pm', 'dd-mon-yyyy')).toBe('2026-09-05');
  });

  it('reads an Excel day number, whatever the format', () => {
    expect(parseStatementDate('46270', 'dd-mm-yyyy')).toBe('2026-09-05');
    expect(parseStatementDate('46270.5', 'dd-mon-yyyy')).toBe('2026-09-05');
  });

  it('refuses what is not a real day in the format', () => {
    expect(parseStatementDate('31-02-2026', 'dd-mm-yyyy')).toBeNull();
    expect(parseStatementDate('2026-09-05', 'dd-mm-yyyy')).toBeNull();
    expect(parseStatementDate('13/05/2026', 'mm-dd-yyyy')).toBeNull();
    expect(parseStatementDate('05-09-2026', 'yyyy-mm-dd')).toBeNull();
    expect(parseStatementDate('05-Sept-2026', 'dd-mon-yyyy')).toBe('2026-09-05');
    expect(parseStatementDate('05-Xyz-2026', 'dd-mon-yyyy')).toBeNull();
    expect(parseStatementDate('Opening', 'dd-mon-yyyy')).toBeNull();
    expect(parseStatementDate('', 'dd-mm-yyyy')).toBeNull();
  });
});

describe('parseStatementAmount', () => {
  it('reads rupees as statements print them', () => {
    expect(parseStatementAmount('₹1,23,456.50')).toEqual({
      kind: 'amount',
      paise: 12_345_650,
      side: null,
    });
    expect(parseStatementAmount('Rs. 99.5')).toEqual({ kind: 'amount', paise: 9950, side: null });
    expect(parseStatementAmount('INR 10')).toEqual({ kind: 'amount', paise: 1000, side: null });
    expect(parseStatementAmount('-1,234')).toEqual({ kind: 'amount', paise: -123_400, side: null });
    expect(parseStatementAmount('(1,234.00)')).toEqual({
      kind: 'amount',
      paise: -123_400,
      side: null,
    });
    expect(parseStatementAmount('(-5)')).toEqual({ kind: 'amount', paise: 500, side: null });
    expect(parseStatementAmount('+7')).toEqual({ kind: 'amount', paise: 700, side: null });
    expect(parseStatementAmount('1,180.00 Dr')).toEqual({
      kind: 'amount',
      paise: 118_000,
      side: 'dr',
    });
    expect(parseStatementAmount('500 cr.')).toEqual({ kind: 'amount', paise: 50_000, side: 'cr' });
    expect(parseStatementAmount('-0')).toEqual({ kind: 'amount', paise: 0, side: null });
  });

  it('treats an empty cell or a dash as blank, and anything else as not an amount', () => {
    expect(parseStatementAmount('  ')).toEqual({ kind: 'blank' });
    expect(parseStatementAmount('-')).toEqual({ kind: 'blank' });
    expect(parseStatementAmount('12.345')).toEqual({ kind: 'invalid' });
    expect(parseStatementAmount('abc')).toEqual({ kind: 'invalid' });
    expect(parseStatementAmount('99999999999999')).toEqual({ kind: 'invalid' });
  });
});

describe('classifyLine', () => {
  it("names a kind by the template's words, else by sign", () => {
    const rules = layout.typeRules;
    expect(classifyLine('CN', rules, -100)).toBe('credit_note');
    expect(classifyLine('cn-scheme', rules, -100)).toBe('credit_note');
    expect(classifyLine('Credit Note (scheme)', rules, -100)).toBe('credit_note');
    expect(classifyLine('CNF', rules, -100)).toBe('other');
    expect(classifyLine('RCPT', rules, -100)).toBe('payment');
    expect(classifyLine(null, rules, 100)).toBe('invoice');
    expect(classifyLine('', rules, -100)).toBe('other');
    expect(classifyLine('Journal', { debit_note: [''] }, -1)).toBe('other');
  });
});

describe('parseStatementRows', () => {
  const header = ['Date', 'Doc No', 'Type', 'Ref', 'Narration', 'Debit', 'Credit'];

  it('reads lines with signs from the debit and credit columns, skipping blanks and totals', () => {
    const parsed = parseStatementRows(
      [
        header,
        ['01-09-2026', '', 'Opening Balance', '', '', '25,000.00', ''],
        ['05-09-2026', 'INV/881', 'INV', 'PO-12', 'Paint  supply', '1,18,000.00', ''],
        ['', '', '', '', '', '', ''],
        ['12-09-2026', 'CN/77', 'CN', '', 'Monsoon scheme', '', '5,000'],
        ['15-09-2026', '', 'RCPT', 'UTR123', '', '', '50,000.00'],
        ['20-09-2026', 'DN/2', 'Debit Note', '', '', '0', ''],
        ['', '', 'Total', '', '', '1,43,000.00', '55,000.00'],
        ['21-09-2026', 'Note', '', '', 'No amount', '', ''],
      ],
      layout,
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.skipped.map((row) => row.row)).toEqual([7, 8, 9]);
    expect(parsed.lines).toEqual([
      {
        rowNumber: 2,
        lineDate: '2026-09-01',
        kind: 'opening',
        documentNumber: null,
        typeText: 'Opening Balance',
        reference: null,
        description: null,
        amountPaise: 2_500_000,
      },
      {
        rowNumber: 3,
        lineDate: '2026-09-05',
        kind: 'invoice',
        documentNumber: 'INV/881',
        typeText: 'INV',
        reference: 'PO-12',
        description: 'Paint supply',
        amountPaise: 11_800_000,
      },
      expect.objectContaining({ rowNumber: 5, kind: 'credit_note', amountPaise: -500_000 }),
      expect.objectContaining({ rowNumber: 6, kind: 'payment', amountPaise: -5_000_000 }),
    ]);
    expect(parsed.periodFrom).toBe('2026-09-01');
    expect(parsed.periodTo).toBe('2026-09-15');
    expect(parsed.openingBalancePaise).toBe(2_500_000);
  });

  it('reads a signed column by its sign convention or a Dr / Cr mark, after the rows to skip', () => {
    const signed: StatementLayout = {
      ...layout,
      headerRowsToSkip: 2,
      typeColumn: null,
      referenceColumn: null,
      descriptionColumn: null,
      amountMode: 'signed',
      debitColumn: null,
      creditColumn: null,
      amountColumn: 'Amount',
      signConvention: 'credit_positive',
      dateFormat: 'yyyy-mm-dd',
    };
    const parsed = parseStatementRows(
      [
        ['Apex Paints Ltd'],
        ['Statement of account'],
        ['Date', 'Doc No', 'Amount'],
        ['2026-09-05', 'INV-1', '-1180'],
        ['2026-09-06', 'CN-1', '500'],
        ['2026-09-07', 'INV-2', '200 Dr'],
        ['2026-09-08', 'CN-2', '-300 Cr'],
        ['2026-09-09', 'X', ''],
        ['2026-09-10'],
      ],
      signed,
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.lines.map((line) => [line.documentNumber, line.kind, line.amountPaise])).toEqual([
      ['INV-1', 'invoice', 118_000],
      ['CN-1', 'other', -50_000],
      ['INV-2', 'invoice', 20_000],
      ['CN-2', 'other', -30_000],
    ]);
    expect(parsed.skipped.map((row) => row.row)).toEqual([8, 9]);
    expect(parsed.openingBalancePaise).toBeNull();
    const debitFirst = parseStatementRows(
      [
        ['Date', 'Doc No', 'Amount'],
        ['2026-09-05', 'INV-1', '1180'],
      ],
      { ...signed, headerRowsToSkip: 0, signConvention: 'debit_positive' },
    );
    expect(debitFirst.lines[0]?.amountPaise).toBe(118_000);
    const opening = parseStatementRows(
      [
        ['Date', 'Doc No', 'Type', 'Amount'],
        ['2026-09-01', '', 'Opening', ''],
      ],
      { ...signed, headerRowsToSkip: 0, typeColumn: 'Type' },
    );
    expect(opening.lines[0]).toMatchObject({ kind: 'opening', amountPaise: 0 });
    expect(opening.openingBalancePaise).toBe(0);
  });

  it('names every missing column', () => {
    const parsed = parseStatementRows([['Date', 'Debit']], layout);
    expect(parsed.errors.map((error) => error.column)).toEqual([
      'Doc No',
      'Type',
      'Ref',
      'Narration',
      'Credit',
    ]);
    expect(parseStatementRows([], { ...layout, headerRowsToSkip: 3 }).errors[0]?.message).toBe(
      'No column "Date" in the header row (row 4)',
    );
  });

  it('refuses unreadable dates and amounts, and a file with no lines', () => {
    const parsed = parseStatementRows(
      [
        header,
        ['31-02-2026', 'INV/1', '', '', '', '100', ''],
        ['01-09-2026', 'INV/2', '', '', '', '', 'ten'],
        ['Opening balance', '', '', '', '', '100', ''],
        ['ten', '', '', '', '', 'x', ''],
      ],
      layout,
    );
    expect(parsed.errors).toEqual([
      { row: 2, column: 'Date', message: '"31-02-2026" is not a date written DD-MM-YYYY' },
      { row: 3, column: null, message: 'The debit or credit is not an amount' },
      { row: 5, column: 'Date', message: '"ten" is not a date written DD-MM-YYYY' },
    ]);
    expect(parsed.skipped.map((row) => row.row)).toEqual([4]);
    const signed = parseStatementRows(
      [
        ['Date', 'Doc No', 'Amount'],
        ['05-09-2026', 'A', 'x'],
      ],
      {
        ...layout,
        typeColumn: null,
        referenceColumn: null,
        descriptionColumn: null,
        amountMode: 'signed',
        debitColumn: null,
        creditColumn: null,
        amountColumn: 'Amount',
      },
    );
    expect(signed.errors).toEqual([
      { row: 2, column: null, message: 'The amount is not an amount' },
    ]);
    expect(parseStatementRows([header], layout).errors).toEqual([
      { row: 0, column: null, message: 'The file has no lines with a date and an amount' },
    ]);
  });

  it('refuses more than 5,000 lines, and clips long text', () => {
    const many = Array.from({ length: 5001 }, () => ['05-09-2026', 'X', '', '', '', '1', '']);
    expect(parseStatementRows([header, ...many], layout).errors.at(-1)?.message).toBe(
      'A statement has at most 5,000 lines',
    );
    const long = parseStatementRows(
      [
        header,
        ['05-09-2026', 'D'.repeat(80), 'T'.repeat(80), 'R'.repeat(200), 'N'.repeat(400), '1', ''],
      ],
      layout,
    );
    expect(long.lines[0]).toMatchObject({
      documentNumber: 'D'.repeat(60),
      typeText: 'T'.repeat(60),
      reference: 'R'.repeat(120),
      description: 'N'.repeat(300),
    });
  });
});
