import { inflateRawSync } from 'node:zlib';

/**
 * Reads the first sheet of an Excel workbook (.xlsx) as rows of text, for statement
 * import (P2-M34): enough of ZIP (stored and deflated entries) and of SpreadsheetML
 * (shared and inline strings, numbers, booleans) for the statements brand portals give,
 * with no dependency. Formulas give their saved value. Dates are Excel day numbers, as
 * the statement parser expects.
 */

/** The workbook cannot be read; the message is for people. */
export class XlsxError extends Error {
  override readonly name = 'XlsxError';
}

/** The most one part may inflate to: a guard against ZIP bombs. */
const MAX_PART_BYTES = 64 * 1024 * 1024;

interface Entry {
  readonly method: number;
  readonly compressedSize: number;
  readonly offset: number;
}

/** The archive's entries by name, from its central directory. */
function entries(data: Buffer): Map<string, Entry> {
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end === -1 || end + 22 > data.length) throw new XlsxError('This is not an Excel workbook');
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  const found = new Map<string, Entry>();
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) {
      throw new XlsxError('The workbook is damaged');
    }
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    found.set(data.toString('utf8', at + 46, at + 46 + nameLength), {
      method: data.readUInt16LE(at + 10),
      compressedSize: data.readUInt32LE(at + 20),
      offset: data.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return found;
}

function part(data: Buffer, all: Map<string, Entry>, name: string): string | null {
  const entry = all.get(name);
  if (!entry) return null;
  const at = entry.offset;
  if (at + 30 > data.length || data.readUInt32LE(at) !== 0x04034b50) {
    throw new XlsxError('The workbook is damaged');
  }
  const start = at + 30 + data.readUInt16LE(at + 26) + data.readUInt16LE(at + 28);
  const raw = data.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw.toString('utf8');
  if (entry.method !== 8) throw new XlsxError('The workbook uses a compression we cannot read');
  try {
    return inflateRawSync(raw, { maxOutputLength: MAX_PART_BYTES }).toString('utf8');
  } catch {
    throw new XlsxError('The workbook is damaged or too large');
  }
}

const ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/** XML text with its entities decoded. */
export function xmlText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number(lower.slice(1)));
    return String(ENTITIES[lower]);
  });
}

/** The text of every <t> in a piece of XML, joined (rich text has several). */
const textRuns = (xml: string) =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((run) => xmlText(String(run[1])))
    .join('');

const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** 0-based column of a cell reference such as "AB12". */
export function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference.toUpperCase())?.[0] ?? '';
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** A number as Excel saved it, without float noise: 1234.5600000000001 → "1234.56". */
function numberText(value: string): string {
  const number = Number(value);
  if (!Number.isFinite(number) || value.trim() === '') return value;
  return String(Math.round(number * 1_000_000) / 1_000_000);
}

/** The first sheet's rows, each a list of cell texts (row 1 first; gaps are empty rows). */
export function readXlsxRows(data: Buffer): string[][] {
  const all = entries(data);
  const workbook = part(data, all, 'xl/workbook.xml');
  if (workbook === null) throw new XlsxError('This is not an Excel workbook');
  const firstSheet = /<sheet\s[^>]*>/.exec(workbook)?.[0] ?? '';
  const relationId = attribute(firstSheet, 'r:id');
  const relations = part(data, all, 'xl/_rels/workbook.xml.rels') ?? '';
  const relation = [...relations.matchAll(/<Relationship\s[^>]*>/g)]
    .map((match) => match[0])
    .find((tag) => attribute(tag, 'Id') === relationId);
  const target = relation ? String(attribute(relation, 'Target')) : 'worksheets/sheet1.xml';
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const sheet = part(data, all, sheetPath);
  if (sheet === null) throw new XlsxError('The workbook has no sheet');
  const shared = [
    ...(part(data, all, 'xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((item) => textRuns(String(item[1])));

  const rows: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(attribute(String(rowMatch[1]), 'r') ?? rows.length + 1);
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = String(cellMatch[1]);
      const body = cellMatch[2] ?? '';
      const reference = attribute(tag, 'r');
      const index = reference === null ? cells.length : columnIndex(reference);
      const type = attribute(tag, 't');
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text: string;
      if (type === 'inlineStr') text = textRuns(body);
      else if (value === undefined) text = '';
      else if (type === 's') text = shared[Number(value)] ?? '';
      else if (type === 'b') text = value === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'str' || type === 'e') text = xmlText(value);
      else text = numberText(value);
      while (cells.length < index) cells.push('');
      cells[index] = text;
    }
    while (rows.length < rowNumber - 1) rows.push([]);
    rows[rowNumber - 1] = cells;
  }
  return rows;
}
