import { describe, expect, it } from 'vitest';
import { xlsxFile, zipOf } from '../test-support/statement-files.js';
import { columnIndex, readXlsxRows, xmlText, XlsxError } from './xlsx-reader.js';

const ROWS = [
  ['Apex Paints – statement', null, null],
  ['Date', 'Doc No', 'Debit'],
  [46_270, 'INV/881 & co', 118_000],
  [46_271, '<CN>', 0.1 + 0.2],
  [null, 'flag', true],
  [null, null, false],
];

describe('readXlsxRows', () => {
  it.each([
    ['deflated, shared strings (as Excel saves)', { deflate: true, sharedStrings: true }],
    ['stored, inline strings', { deflate: false, sharedStrings: false }],
  ])('reads the first sheet %s', (_, options) => {
    expect(readXlsxRows(xlsxFile(ROWS, options))).toEqual([
      ['Apex Paints – statement'],
      ['Date', 'Doc No', 'Debit'],
      ['46270', 'INV/881 & co', '118000'],
      ['46271', '<CN>', '0.3'],
      ['', 'flag', 'TRUE'],
      ['', '', 'FALSE'],
    ]);
  });

  it('finds the sheet by an absolute target, and fills skipped rows', () => {
    const sheet =
      '<worksheet><sheetData><row r="1"><c r="B1" t="str"><v>a&amp;b</v></c></row>' +
      '<row r="3"/><row><c t="e"><v>#N/A</v></c><c><v>x</v></c><c t="s"/><c t="s"><v>9</v></c></row>' +
      '</sheetData></worksheet>';
    const data = zipOf(
      [
        {
          name: 'xl/workbook.xml',
          data: Buffer.from('<workbook><sheets><sheet name="A" r:id="r7"/></sheets></workbook>'),
        },
        {
          name: 'xl/_rels/workbook.xml.rels',
          data: Buffer.from(
            '<Relationships><Relationship Id="r7" Target="/xl/sheets/one.xml"/></Relationships>',
          ),
        },
        { name: 'xl/sheets/one.xml', data: Buffer.from(sheet) },
      ],
      true,
    );
    expect(readXlsxRows(data)).toEqual([['', 'a&b'], [], [], ['#N/A', 'x', '', '']]);
  });

  it('falls back to the first worksheet when the workbook names no relation', () => {
    const data = zipOf(
      [
        { name: 'xl/workbook.xml', data: Buffer.from('<workbook><sheets/></workbook>') },
        {
          name: 'xl/worksheets/sheet1.xml',
          data: Buffer.from(
            '<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>',
          ),
        },
      ],
      false,
    );
    expect(readXlsxRows(data)).toEqual([['7']]);
  });

  it('refuses what is not a workbook, a damaged one, or one without its sheet', () => {
    const message = (data: Buffer) => {
      try {
        readXlsxRows(data);
      } catch (error) {
        expect(error).toBeInstanceOf(XlsxError);
        return (error as Error).message;
      }
      return 'read';
    };
    expect(message(Buffer.from('PK\u0003\u0004 not really'))).toBe('This is not an Excel workbook');
    expect(message(zipOf([{ name: 'word/document.xml', data: Buffer.from('<w/>') }], false))).toBe(
      'This is not an Excel workbook',
    );
    expect(
      message(zipOf([{ name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') }], false)),
    ).toBe('The workbook has no sheet');
    const good = xlsxFile([['a']], { deflate: false });
    // The central directory's first entry broken.
    const brokenDirectory = Buffer.from(good);
    brokenDirectory.writeUInt32LE(0, brokenDirectory.readUInt32LE(brokenDirectory.length - 6));
    expect(message(brokenDirectory)).toBe('The workbook is damaged');
    // A local header broken.
    const brokenLocal = Buffer.from(good);
    brokenLocal.writeUInt32LE(0, 0);
    expect(message(brokenLocal)).toBe('The workbook is damaged');
    // An unknown compression method (here 12, bzip2) in the directory.
    const bzip = Buffer.from(good);
    bzip.writeUInt16LE(12, bzip.readUInt32LE(bzip.length - 6) + 10);
    expect(message(bzip)).toBe('The workbook uses a compression we cannot read');
    // Deflated bytes that do not inflate.
    const garbled = Buffer.from(xlsxFile([['a']], { deflate: true }));
    garbled.fill(0xff, 30 + 'xl/workbook.xml'.length, 40 + 'xl/workbook.xml'.length);
    expect(message(garbled)).toBe('The workbook is damaged or too large');
    // An end record that points past the file.
    expect(message(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe('This is not an Excel workbook');
  });
});

describe('xmlText and columnIndex', () => {
  it('decode entities and column letters', () => {
    expect(xmlText('&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos; &#8377; &#x20B9; &nbsp;')).toBe(
      '<a> & "b" \'c\' ₹ ₹ &nbsp;',
    );
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('ab12')).toBe(27);
    expect(columnIndex('12')).toBe(-1);
  });
});
