import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { csvFile, xlsxFile } from '../test-support/statement-files.js';
import {
  CSV_TYPE,
  readStatementFile,
  STATEMENT_FILE_MESSAGE,
  statementFileName,
  StatementFileError,
  XLSX_TYPE,
} from './statement-file.js';

const refusal = (fileName: string, data: Buffer) => {
  try {
    readStatementFile(fileName, data);
  } catch (error) {
    expect(error).toBeInstanceOf(StatementFileError);
    return (error as Error).message;
  }
  return 'read';
};

describe('readStatementFile', () => {
  it('reads a CSV in UTF-8 (BOM dropped) or Windows-1252, and an Excel workbook', () => {
    const csv = Buffer.concat([
      Buffer.from('\uFEFF'),
      csvFile([
        ['Date', 'Doc'],
        ['05-09-2026', '₹ INV'],
      ]),
    ]);
    const read = readStatementFile('Sept.csv', csv);
    expect(read).toMatchObject({
      fileName: 'Sept.csv',
      contentType: CSV_TYPE,
      sizeBytes: csv.length,
      sha256: createHash('sha256').update(csv).digest('hex'),
      rows: [
        ['Date', 'Doc'],
        ['05-09-2026', '₹ INV'],
      ],
    });
    expect(read.data).toBe(csv);
    const latin = Buffer.from([0x44, 0x61, 0x74, 0x65, 0x0d, 0x0a, 0x93, 0x41, 0x94]);
    expect(readStatementFile('old.TXT', latin).rows).toEqual([['Date'], ['“A”']]);
    const workbook = readStatementFile('ledger.xlsx', xlsxFile([['Date'], [46_270]]));
    expect(workbook).toMatchObject({ contentType: XLSX_TYPE, rows: [['Date'], ['46270']] });
  });

  it('refuses empty files, PDFs, old Excel files and anything else, and broken files', () => {
    expect(refusal('a.csv', Buffer.alloc(0))).toBe('The file is empty');
    expect(refusal('a.pdf', Buffer.from('%PDF-1.4'))).toMatch(/PDF statements cannot be read yet/);
    expect(refusal('a.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))).toMatch(
      /\.xlsx\) or CSV first/,
    );
    expect(refusal('a.png', Buffer.from('png'))).toBe(STATEMENT_FILE_MESSAGE);
    expect(refusal('a.csv', Buffer.from([0x41, 0x00, 0x42]))).toBe(STATEMENT_FILE_MESSAGE);
    expect(refusal('a.csv', xlsxFile([['a']]))).toBe(STATEMENT_FILE_MESSAGE);
    expect(refusal('a.xlsx', Buffer.from('PK\u0003\u0004 broken'))).toBe(
      'This is not an Excel workbook',
    );
    expect(refusal('a.csv', Buffer.from('"open'))).toMatch(/never closed/);
  });
});

describe('statementFileName', () => {
  it('drops folders and control characters, adds the extension and keeps 120 characters', () => {
    expect(statementFileName('C:\\Users\\me\\Sept\u202e.csv', 'csv')).toBe('Sept.csv');
    expect(statementFileName('  ', 'xlsx')).toBe('statement.xlsx');
    expect(statementFileName('ledger', 'xlsx')).toBe('ledger.xlsx');
    const long = statementFileName(`${'a'.repeat(200)}.csv`, 'csv');
    expect(long).toHaveLength(117);
    expect(long.endsWith('….csv')).toBe(true);
  });
});
