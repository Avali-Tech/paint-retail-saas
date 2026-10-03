import { toCsv } from '@paint/shared';

// A small reader for Excel workbooks (.xlsx), so a file saved straight from Excel
// can be imported without first saving it as CSV. An .xlsx is a zip of XML parts;
// the browser's DecompressionStream inflates them, DOMParser reads them. Only the
// first sheet's cell values are read: no formulas, styles or dates as dates.

/** Why a spreadsheet could not be read. */
export type SpreadsheetProblem =
  'notSpreadsheet' | 'unsupported' | 'empty' | 'tooLarge' | 'oldFormat';

export class SpreadsheetError extends Error {
  override readonly name = 'SpreadsheetError';

  constructor(readonly problem: SpreadsheetProblem) {
    super(problem);
  }
}

/** The API takes at most this much CSV text (in bytes). */
export const MAX_CSV_BYTES = 3_500_000;

interface ZipEntry {
  readonly method: number;
  readonly size: number;
  /** Where the entry's local header starts. */
  readonly offset: number;
}

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const decoder = new TextDecoder();

/** The zip's entries by name, from its central directory (sizes there are always right). */
function readDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== END_OF_DIRECTORY) end -= 1;
  if (end < 0) throw new SpreadsheetError('notSpreadsheet');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== DIRECTORY_ENTRY) throw new SpreadsheetError('notSpreadsheet');
    // Bit 0: encrypted (a password-protected workbook).
    if ((view.getUint16(at + 8, true) & 1) === 1) throw new SpreadsheetError('unsupported');
    const nameLength = view.getUint16(at + 28, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.set(name, {
      method: view.getUint16(at + 10, true),
      size: view.getUint32(at + 20, true),
      offset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return entries;
}

const streamOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });

/** One entry's bytes: stored as is (method 0) or deflated (method 8). */
async function readEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.offset, true) !== LOCAL_HEADER) {
    throw new SpreadsheetError('notSpreadsheet');
  }
  const start =
    entry.offset +
    30 +
    view.getUint16(entry.offset + 26, true) +
    view.getUint16(entry.offset + 28, true);
  const data = bytes.subarray(start, start + entry.size);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new SpreadsheetError('unsupported');
  const inflated = streamOf(data).pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(inflated).arrayBuffer());
}

/** Every element with this local name, whatever namespace prefix the writer used. */
const all = (node: Document | Element, name: string) => [...node.getElementsByTagNameNS('*', name)];

/** The text of a string item: plain, or rich text runs joined (phonetic hints left out). */
const stringText = (item: Element) =>
  all(item, 't')
    .filter((text) => text.parentElement?.localName !== 'rPh')
    .map((text) => text.textContent)
    .join('');

/** "AB" -> 27 (0-based column). */
function columnIndex(letters: string): number {
  const upper = letters.toUpperCase();
  let index = 0;
  for (let at = 0; at < upper.length; at += 1) index = index * 26 + upper.charCodeAt(at) - 64;
  return index - 1;
}

/** Excel stores 0.3 as 0.30000000000000004; show what the person typed. */
function numberText(value: string): string {
  const number = Number(value);
  return value.trim() === '' || Number.isNaN(number)
    ? value
    : String(Number(number.toPrecision(15)));
}

function cellText(cell: Element, shared: readonly string[]): string {
  const value = all(cell, 'v')[0]?.textContent ?? '';
  switch (cell.getAttribute('t')) {
    case 's':
      return shared[Number(value)] ?? '';
    case 'inlineStr':
      return all(cell, 'is').map(stringText).join('');
    case 'b':
      return value === '1' ? 'TRUE' : 'FALSE';
    case 'str':
    case 'e':
    case 'd':
      return value;
    default:
      return numberText(value);
  }
}

/** The first sheet's part: through the workbook's relationships, else the usual name. */
function sheetPart(workbook: Document | null, relationships: Document | null): string {
  const id = workbook === null ? null : all(workbook, 'sheet')[0]?.getAttribute('r:id');
  const target =
    (relationships === null ? [] : all(relationships, 'Relationship'))
      .find((relationship) => relationship.getAttribute('Id') === id)
      ?.getAttribute('Target') ?? null;
  if (target === null) return 'xl/worksheets/sheet1.xml';
  return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
}

/** The first sheet as rows of cell text, gaps filled so row and column positions match Excel. */
export async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  let entries: Map<string, ZipEntry>;
  try {
    entries = readDirectory(bytes);
  } catch (error) {
    // A truncated file reads past its end (RangeError).
    throw error instanceof SpreadsheetError ? error : new SpreadsheetError('notSpreadsheet');
  }
  const parser = new DOMParser();
  const part = async (name: string): Promise<Document | null> => {
    const entry = entries.get(name);
    if (entry === undefined) return null;
    let data: Uint8Array;
    try {
      data = await readEntry(bytes, entry);
    } catch (error) {
      // Damaged compressed data (TypeError from the decompressor).
      throw error instanceof SpreadsheetError ? error : new SpreadsheetError('notSpreadsheet');
    }
    return parser.parseFromString(decoder.decode(data), 'application/xml');
  };

  const sheet = await part(
    sheetPart(await part('xl/workbook.xml'), await part('xl/_rels/workbook.xml.rels')),
  );
  if (sheet === null) throw new SpreadsheetError('notSpreadsheet');
  const strings = await part('xl/sharedStrings.xml');
  const shared = strings === null ? [] : all(strings, 'si').map(stringText);

  const rows: string[][] = [];
  for (const row of all(sheet, 'row')) {
    const number = Number(row.getAttribute('r') ?? rows.length + 1);
    while (rows.length < number - 1) rows.push([]);
    const cells: string[] = [];
    for (const cell of all(row, 'c')) {
      // "B3": column B. Writers may leave the reference out for the next cell.
      const letters = /^[A-Z]+/i.exec(cell.getAttribute('r') ?? '')?.[0];
      const column = letters === undefined ? cells.length : columnIndex(letters);
      while (cells.length < column) cells.push('');
      cells[column] = cellText(cell, shared);
    }
    rows.push(cells);
  }
  // Leave out empty rows at the end and empty columns on the right.
  while (rows.at(-1)?.every((cell) => cell === '') === true) rows.pop();
  const width = Math.max(0, ...rows.map((cells) => cells.findLastIndex((cell) => cell !== '') + 1));
  if (width === 0) throw new SpreadsheetError('empty');
  return rows.map((cells) => Array.from({ length: width }, (_, index) => cells[index] ?? ''));
}

/** A chosen file as the CSV text the import API reads (CSV as is, .xlsx converted). */
export async function readSpreadsheet(file: File): Promise<string> {
  if (/\.(xls|ods|numbers)$/i.test(file.name)) throw new SpreadsheetError('oldFormat');
  const csv = /\.xlsx$/i.test(file.name)
    ? toCsv(await readXlsx(new Uint8Array(await file.arrayBuffer())))
    : (await file.text()).replace(/^\uFEFF/, '');
  if (new TextEncoder().encode(csv).length > MAX_CSV_BYTES) {
    throw new SpreadsheetError('tooLarge');
  }
  return csv;
}
