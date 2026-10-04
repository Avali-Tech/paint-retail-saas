import { describe, expect, it } from 'vitest';
import { workbookFiles, zip } from './test-support/zip.js';
import { MAX_CSV_BYTES, SpreadsheetError, readSpreadsheet, readXlsx } from './xlsx.js';

const problem = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return error instanceof SpreadsheetError ? error.problem : 'other';
  }
  return 'none';
};

describe('readXlsx', () => {
  it('reads shared, inline and rich strings, numbers, booleans and gaps', async () => {
    const bytes = await zip(
      workbookFiles({
        shared:
          '<si><t>sku</t></si><si><t>qty</t></si><si><r><t>Apex </t></r><r><t>Ultima</t></r><rPh><t>ヨミ</t></rPh></si>',
        sheet: [
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>note</t></is></c></row>',
          '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3"><v>0.30000000000000004</v></c><c r="C3" t="b"><v>1</v></c><c r="D3" t="b"><v>0</v></c></row>',
          '<row><c t="str"><v>=A1</v></c><c t="e"><v>#N/A</v></c><c t="d"><v>2026-10-01</v></c><c s="1"/></row>',
          '<row r="5"><c r="A5" t="s"><v>99</v></c><c r="B5" t="n"><v>abc</v></c><c r="C5"><v>9876543210</v></c></row>',
          '<row r="6"><c r="A6" s="2"/></row>',
          '<row r="7"/>',
        ].join(''),
      }),
    );
    expect(await readXlsx(bytes)).toEqual([
      ['sku', 'qty', '', 'note'],
      ['', '', '', ''],
      ['Apex Ultima', '0.3', 'TRUE', 'FALSE'],
      ['=A1', '#N/A', '2026-10-01', ''],
      ['', 'abc', '9876543210', ''],
    ]);
  });

  it('follows the workbook to its first sheet, stored or with sizes after the data', async () => {
    const files = workbookFiles({
      sheet: '<row r="1"><c r="A1" t="inlineStr"><is><t>store</t></is></c></row>',
      target: '/xl/worksheets/first.xml',
      sheetName: 'xl/worksheets/first.xml',
    }).map((file, index) => ({ ...file, method: index === 0 ? 0 : 8, dataDescriptor: true }));
    expect(await readXlsx(await zip(files))).toEqual([['store']]);
  });

  it('falls back to sheet1 without a workbook or a matching relationship', async () => {
    const [, , sheet] = workbookFiles({
      sheet: '<row r="1"><c r="A1"><v>1</v></c></row>',
    });
    expect(await readXlsx(await zip([sheet ?? { name: '', text: '' }]))).toEqual([['1']]);
    const files = workbookFiles({
      sheet: '<row r="1"><c r="A1"><v>2</v></c></row>',
      target: 'worksheets/sheet1.xml',
    }).filter((file) => !file.name.includes('_rels'));
    expect(await readXlsx(await zip(files))).toEqual([['2']]);
  });

  it('refuses files that are not workbooks, are protected or are empty', async () => {
    expect(await problem(readXlsx(new TextEncoder().encode('sku,qty\nA,1')))).toBe(
      'notSpreadsheet',
    );
    const valid = await zip(workbookFiles({ sheet: '<row r="1"><c r="A1"><v>1</v></c></row>' }));

    // The directory points somewhere that is not a directory entry.
    const misplaced = valid.slice();
    const end = misplaced.length - 24;
    new DataView(misplaced.buffer).setUint32(end + 16, 0, true);
    expect(await problem(readXlsx(misplaced))).toBe('notSpreadsheet');

    // The directory points past the end of the file.
    const truncated = valid.slice();
    new DataView(truncated.buffer).setUint32(end + 16, 0xffffff, true);
    expect(await problem(readXlsx(truncated))).toBe('notSpreadsheet');

    const sheetOnly = (file: { method?: number; encrypted?: boolean; raw?: Uint8Array }) =>
      zip([{ name: 'xl/worksheets/sheet1.xml', text: '<worksheet/>', ...file }]);
    expect(await problem(readXlsx(await sheetOnly({ encrypted: true })))).toBe('unsupported');
    expect(await problem(readXlsx(await sheetOnly({ method: 12 })))).toBe('unsupported');
    expect(await problem(readXlsx(await sheetOnly({ raw: new Uint8Array([9, 9, 9]) })))).toBe(
      'notSpreadsheet',
    );
    expect(await problem(readXlsx(await sheetOnly({ method: 0 })))).toBe('empty');
    expect(await problem(readXlsx(await zip([{ name: 'docProps/app.xml', text: '<x/>' }])))).toBe(
      'notSpreadsheet',
    );

    // The directory names an entry whose local header is missing.
    const noHeader = valid.slice();
    new DataView(noHeader.buffer).setUint32(0, 0, true);
    expect(await problem(readXlsx(noHeader))).toBe('notSpreadsheet');
  });
});

describe('readSpreadsheet', () => {
  it('reads CSV as text without its byte order mark', async () => {
    const file = new File(['\uFEFFsku,qty\r\nA,1\r\n'], 'stock.CSV', { type: 'text/csv' });
    expect(await readSpreadsheet(file)).toBe('sku,qty\r\nA,1\r\n');
  });

  it('turns an .xlsx into CSV', async () => {
    const bytes = await zip(
      workbookFiles({
        sheet:
          '<row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Shah, Sons</t></is></c></row>',
      }),
    );
    expect(await readSpreadsheet(new File([bytes], 'parties.xlsx'))).toBe(
      'name\r\n"Shah, Sons"\r\n',
    );
  });

  it('refuses old Excel files and files too big to import', async () => {
    expect(await problem(readSpreadsheet(new File(['x'], 'old.xls')))).toBe('oldFormat');
    const big = new File(['a'.repeat(MAX_CSV_BYTES + 1)], 'big.csv');
    expect(await problem(readSpreadsheet(big))).toBe('tooLarge');
  });
});
