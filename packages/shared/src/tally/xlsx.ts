import { paiseToRupees } from '../money.js';
import { escapeXml } from './xml.js';
import { zip } from './zip.js';

/**
 * A minimal .xlsx writer (ECMA-376 SpreadsheetML): inline strings, numbers,
 * dates and amounts, a bold frozen header row, column widths. Its output is
 * deterministic, so golden files can be compared byte for byte.
 */

export type XlsxCell =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'amount'; readonly paise: number }
  | { readonly kind: 'date'; readonly iso: string }
  | null;

export interface XlsxColumn {
  readonly header: string;
  /** Width in characters. */
  readonly width: number;
}

export interface XlsxSheet {
  /** At most 31 characters, none of `[]:*?/\`; the caller's names are fixed and safe. */
  readonly name: string;
  readonly columns: readonly XlsxColumn[];
  readonly rows: readonly (readonly XlsxCell[])[];
}

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Style ids in styles.xml's cellXfs. */
const STYLE = { header: 1, date: 2, amount: 3 } as const;

/** 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26));
  return index < 26 ? letter : `${columnName(Math.floor(index / 26) - 1)}${letter}`;
}

/** Excel's serial day number (1900 date system): days since 30 December 1899. */
export function excelSerial(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  return (
    (Date.UTC(Number(year), Number(month) - 1, Number(day)) - Date.UTC(1899, 11, 30)) / 86_400_000
  );
}

const text = (ref: string, value: string, style: number) =>
  `<c r="${ref}" s="${String(style)}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;

function cellXml(cell: XlsxCell, ref: string): string {
  if (cell === null) return '';
  switch (cell.kind) {
    case 'text':
      return text(ref, cell.value, 0);
    case 'amount':
      return `<c r="${ref}" s="${String(STYLE.amount)}"><v>${paiseToRupees(cell.paise)}</v></c>`;
    case 'date':
      return `<c r="${ref}" s="${String(STYLE.date)}"><v>${String(excelSerial(cell.iso))}</v></c>`;
  }
}

function sheetXml(sheet: XlsxSheet): string {
  const header = `<row r="1">${sheet.columns
    .map((column, index) => text(`${columnName(index)}1`, column.header, STYLE.header))
    .join('')}</row>`;
  const rows = sheet.rows.map((row, rowIndex) => {
    const r = String(rowIndex + 2);
    const cells = row.map((cell, index) => cellXml(cell, `${columnName(index)}${r}`)).join('');
    return `<row r="${r}">${cells}</row>`;
  });
  const cols = sheet.columns
    .map((column, index) => {
      const n = String(index + 1);
      return `<col min="${n}" max="${n}" width="${String(column.width)}" customWidth="1"/>`;
    })
    .join('');
  return (
    DECLARATION +
    `<worksheet xmlns="${MAIN}" xmlns:r="${REL}">` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols>` +
    `<sheetData>${[header, ...rows].join('')}</sheetData>` +
    '</worksheet>'
  );
}

const STYLES =
  DECLARATION +
  `<styleSheet xmlns="${MAIN}">` +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd\\-mm\\-yyyy"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** Writes the sheets, in order, as an .xlsx file. */
export function writeXlsx(sheets: readonly XlsxSheet[]): Uint8Array {
  const encoder = new TextEncoder();
  const file = (path: string, content: string) => ({ path, data: encoder.encode(content) });
  const numbered = sheets.map((sheet, index) => ({ sheet, n: String(index + 1) }));
  return zip([
    file(
      '[Content_Types].xml',
      DECLARATION +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        numbered
          .map(
            ({ n }) =>
              `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        '</Types>',
    ),
    file(
      '_rels/.rels',
      DECLARATION +
        `<Relationships xmlns="${PKG_REL}">` +
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>` +
        '</Relationships>',
    ),
    file(
      'xl/workbook.xml',
      DECLARATION +
        `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>` +
        numbered
          .map(
            ({ sheet, n }) =>
              `<sheet name="${escapeXml(sheet.name)}" sheetId="${n}" r:id="rId${n}"/>`,
          )
          .join('') +
        '</sheets></workbook>',
    ),
    file(
      'xl/_rels/workbook.xml.rels',
      DECLARATION +
        `<Relationships xmlns="${PKG_REL}">` +
        numbered
          .map(
            ({ n }) =>
              `<Relationship Id="rId${n}" Type="${REL}/worksheet" Target="worksheets/sheet${n}.xml"/>`,
          )
          .join('') +
        `<Relationship Id="rId${String(sheets.length + 1)}" Type="${REL}/styles" Target="styles.xml"/>` +
        '</Relationships>',
    ),
    file('xl/styles.xml', STYLES),
    ...numbered.map(({ sheet, n }) => file(`xl/worksheets/sheet${n}.xml`, sheetXml(sheet))),
  ]);
}
