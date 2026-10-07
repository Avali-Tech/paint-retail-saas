import { crc32 as nodeCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { columnName, excelSerial, writeXlsx } from './xlsx.js';
import { crc32, zip } from './zip.js';

/** Reads a stored (uncompressed) ZIP through its central directory, checking every CRC. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map<string, string>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    expect(view.getUint16(at + 10, true)).toBe(0); // stored
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    expect(nodeCrc32(data)).toBe(crc);
    files.set(name, decoder.decode(data));
    at += 46 + nameLength;
  }
  return files;
}

describe('crc32', () => {
  it('agrees with zlib', () => {
    const data = new TextEncoder().encode('Sharma Paints & Hardware, ₹1,180.00');
    expect(crc32(data)).toBe(nodeCrc32(data));
    expect(crc32(new Uint8Array())).toBe(0);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('zip', () => {
  it('stores entries that read back intact, the same bytes every time', () => {
    const entries = [
      { path: 'a.txt', data: new TextEncoder().encode('hello') },
      { path: 'dir/ü.xml', data: new TextEncoder().encode('<x/>') },
    ];
    const archive = zip(entries);
    expect(unzip(archive)).toEqual(
      new Map([
        ['a.txt', 'hello'],
        ['dir/ü.xml', '<x/>'],
      ]),
    );
    expect(zip(entries)).toEqual(archive);
  });
});

describe('xlsx', () => {
  it('names columns as Excel does', () => {
    expect([0, 25, 26, 51, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
  });

  it('counts dates in Excel serial days', () => {
    expect(excelSerial('1900-03-01')).toBe(61);
    expect(excelSerial('2026-09-01')).toBe(46266);
  });

  it('writes a workbook with typed cells, a frozen bold header and widths', () => {
    const files = unzip(
      writeXlsx([
        {
          name: 'Sales & Returns',
          columns: [
            { header: 'Date', width: 12 },
            { header: 'Party', width: 20 },
            { header: 'Amount', width: 10 },
          ],
          rows: [
            [
              { kind: 'date', iso: '2026-09-01' },
              { kind: 'text', value: ' Reddy & Sons ' },
              { kind: 'amount', paise: -5 },
            ],
            [null, null, { kind: 'amount', paise: 118000 }],
          ],
        },
        { name: 'Empty', columns: [], rows: [] },
      ]),
    );
    expect([...files.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    expect(files.get('xl/workbook.xml')).toContain(
      '<sheets><sheet name="Sales &amp; Returns" sheetId="1" r:id="rId1"/><sheet name="Empty" sheetId="2" r:id="rId2"/></sheets>',
    );
    expect(files.get('xl/_rels/workbook.xml.rels')).toContain(
      'Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"',
    );
    const sheet = files.get('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<col min="2" max="2" width="20" customWidth="1"/>');
    expect(sheet).toContain(
      '<row r="1"><c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Date</t></is></c>',
    );
    expect(sheet).toContain(
      '<row r="2"><c r="A2" s="2"><v>46266</v></c><c r="B2" s="0" t="inlineStr"><is><t xml:space="preserve"> Reddy &amp; Sons </t></is></c><c r="C2" s="3"><v>-0.05</v></c></row>',
    );
    expect(sheet).toContain('<row r="3"><c r="C3" s="3"><v>1180.00</v></c></row>');
    expect(files.get('xl/worksheets/sheet2.xml')).toContain(
      '<cols></cols><sheetData><row r="1"></row></sheetData>',
    );
  });
});
