import { createHash } from 'node:crypto';
import { CsvError, parseCsv } from '@paint/shared';
import { readXlsxRows, XlsxError } from './xlsx-reader.js';

/**
 * A statement file as uploaded (P2-M34): a CSV or an Excel workbook (.xlsx), told apart
 * by its content and name, never by the type the browser claimed. PDF statements are
 * research ([PO-91]).
 */

export const STATEMENT_FILE_MESSAGE = 'Upload the statement as a CSV or an Excel (.xlsx) file';

export const CSV_TYPE = 'text/csv';
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface StatementFile {
  readonly fileName: string;
  readonly contentType: typeof CSV_TYPE | typeof XLSX_TYPE;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** The bytes, kept after a clean scan. */
  readonly data: Buffer;
  readonly rows: string[][];
}

/** Why a file cannot be read; the message is for people. */
export class StatementFileError extends Error {
  override readonly name = 'StatementFileError';
}

// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g;

/** A file name safe to store and show: no folders or control characters, at most 120 long. */
export function statementFileName(name: string, extension: 'csv' | 'xlsx'): string {
  const base = name
    .replace(/^.*[\\/]/, '')
    .replace(UNSAFE, '')
    .replace(/\s+/g, ' ')
    .trim();
  const named = base.toLowerCase().endsWith(`.${extension}`)
    ? base
    : `${base || 'statement'}.${extension}`;
  return named.length <= 120 ? named : `${named.slice(0, 115 - extension.length)}….${extension}`;
}

/** Text in UTF-8 (a BOM dropped), or Windows-1252 as older Excel saves CSV. */
function decodeText(data: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data);
  } catch {
    return new TextDecoder('windows-1252').decode(data);
  }
}

/** Reads an uploaded statement into rows of text, or says why it cannot. */
export function readStatementFile(fileName: string, data: Buffer): StatementFile {
  if (data.length === 0) throw new StatementFileError('The file is empty');
  const lower = fileName.toLowerCase();
  const zipped = data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (zipped && lower.endsWith('.xlsx')) {
    try {
      return {
        fileName: statementFileName(fileName, 'xlsx'),
        contentType: XLSX_TYPE,
        sizeBytes: data.length,
        sha256,
        data,
        rows: readXlsxRows(data),
      };
    } catch (error) {
      throw new StatementFileError((error as XlsxError).message);
    }
  }
  if (!zipped && !data.includes(0) && /\.(csv|txt)$/.test(lower)) {
    try {
      return {
        fileName: statementFileName(fileName, 'csv'),
        contentType: CSV_TYPE,
        sizeBytes: data.length,
        sha256,
        data,
        rows: parseCsv(decodeText(data)),
      };
    } catch (error) {
      throw new StatementFileError((error as CsvError).message);
    }
  }
  if (lower.endsWith('.pdf')) {
    throw new StatementFileError(
      'PDF statements cannot be read yet: download the statement as Excel or CSV from the brand portal',
    );
  }
  if (lower.endsWith('.xls')) {
    throw new StatementFileError('Save the statement as an Excel workbook (.xlsx) or CSV first');
  }
  throw new StatementFileError(STATEMENT_FILE_MESSAGE);
}
