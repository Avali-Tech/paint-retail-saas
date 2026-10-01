/**
 * CSV as Excel and Google Sheets write it (RFC 4180): comma-separated, fields
 * in double quotes may hold commas, line breaks and doubled quotes ("").
 */

/** The file cannot be read as CSV; `row` is the spreadsheet row (1 = header). */
export class CsvError extends Error {
  override readonly name = 'CsvError';

  constructor(
    message: string,
    readonly row: number,
  ) {
    super(message);
  }
}

/** Splits CSV text into records of fields. Accepts LF, CRLF or CR line endings and a BOM. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  let i = text.startsWith('﻿') ? 1 : 0;

  const endField = () => {
    record.push(field);
    field = '';
    afterQuote = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  for (; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
        afterQuote = true;
      }
    } else if (char === ',') {
      endField();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
    } else if (afterQuote) {
      throw new CsvError(
        `Unexpected text after a closing quote on row ${String(records.length + 1)}`,
        records.length + 1,
      );
    } else if (char === '"' && field === '') {
      quoted = true;
    } else {
      field += char;
    }
  }
  if (quoted) {
    throw new CsvError(
      `A quoted value on row ${String(records.length + 1)} is never closed`,
      records.length + 1,
    );
  }
  // A final line break does not start another record.
  if (field !== '' || record.length > 0 || afterQuote) endRecord();
  return records;
}

const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

/** Writes records as CSV with CRLF line endings, quoting only where needed. */
export function toCsv(records: readonly (readonly string[])[]): string {
  return records
    .map((record) =>
      record
        .map((value) => (NEEDS_QUOTES.test(value) ? `"${value.replaceAll('"', '""')}"` : value))
        .join(','),
    )
    .join('\r\n')
    .concat('\r\n');
}

export interface CsvRow {
  /** Spreadsheet row number, counting the header as row 1. */
  readonly row: number;
  /** Cell text by column name, trimmed; missing cells are ''. */
  readonly values: Readonly<Record<string, string>>;
}

export interface CsvTable {
  readonly columns: string[];
  readonly rows: CsvRow[];
}

/** Turns a header such as " Pack Size " into "pack_size". */
export function columnKey(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/g, '_');
}

/**
 * Reads CSV with a header row into named rows. Blank rows (Excel often leaves
 * some at the end) are skipped, but row numbers still match the spreadsheet.
 */
export function readCsvTable(text: string): CsvTable {
  const [header, ...records] = parseCsv(text);
  if (!header || header.every((cell) => cell.trim() === '')) {
    throw new CsvError('The file is empty; the first row must name the columns', 1);
  }
  const columns = header.map(columnKey);
  columns.forEach((column, index) => {
    if (column === '') throw new CsvError(`Column ${String(index + 1)} has no name`, 1);
    if (columns.indexOf(column) !== index) {
      throw new CsvError(`The column "${column}" appears twice`, 1);
    }
  });
  const rows: CsvRow[] = [];
  records.forEach((record, index) => {
    if (record.every((cell) => cell.trim() === '')) return;
    const row = index + 2;
    if (record.length > columns.length && record.slice(columns.length).some((c) => c.trim())) {
      throw new CsvError(`Row ${String(row)} has more values than there are columns`, row);
    }
    rows.push({
      row,
      values: Object.fromEntries(columns.map((column, i) => [column, (record[i] ?? '').trim()])),
    });
  });
  return { columns, rows };
}
