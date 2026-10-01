import { describe, expect, it } from 'vitest';
import { CsvError, columnKey, parseCsv, readCsvTable, toCsv } from './csv.js';

describe('parseCsv', () => {
  it('splits plain records', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('accepts CRLF, CR and a missing final line break', () => {
    expect(parseCsv('a,b\r\n1,2\r3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('removes the byte-order mark Excel adds', () => {
    expect(parseCsv('﻿name\nRaj')).toEqual([['name'], ['Raj']]);
  });

  it('keeps commas, line breaks and doubled quotes inside quotes', () => {
    expect(parseCsv('"Shop 4, MG Road","Line 1\nLine 2","6"" roller"\n')).toEqual([
      ['Shop 4, MG Road', 'Line 1\nLine 2', '6" roller'],
    ]);
  });

  it('keeps empty fields, including quoted ones and a trailing one', () => {
    expect(parseCsv('a,,""\n,\n""')).toEqual([['a', '', ''], ['', ''], ['']]);
  });

  it('treats a quote in the middle of an unquoted value as text', () => {
    expect(parseCsv('6" brush,x')).toEqual([['6" brush', 'x']]);
  });

  it('returns nothing for empty text', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('refuses a quoted value that is never closed', () => {
    expect(() => parseCsv('a\n"open,b\n')).toThrow(
      new CsvError('A quoted value on row 2 is never closed', 2),
    );
  });

  it('refuses text after a closing quote', () => {
    const error = (() => {
      try {
        parseCsv('a\nb\n"x"y');
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(CsvError);
    expect(error).toMatchObject({
      row: 3,
      message: 'Unexpected text after a closing quote on row 3',
    });
  });
});

describe('toCsv', () => {
  it('quotes only values that need it and ends lines with CRLF', () => {
    expect(
      toCsv([
        ['sku', 'name', 'note'],
        ['AP-1L', 'Apex, 1 L', 'Say "hi"'],
        ['X', ' padded', 'two\nlines'],
      ]),
    ).toBe('sku,name,note\r\nAP-1L,"Apex, 1 L","Say ""hi"""\r\nX," padded","two\nlines"\r\n');
  });

  it('round-trips through parseCsv', () => {
    const records = [
      ['a', 'b,c', '"q"'],
      ['line\r\nbreak', '', 'end '],
    ];

    expect(parseCsv(toCsv(records))).toEqual(records);
  });
});

describe('columnKey', () => {
  it.each([
    [' Pack Size ', 'pack_size'],
    ['GST-Percent', 'gst_percent'],
    ['sku', 'sku'],
  ])('%s → %s', (header, key) => {
    expect(columnKey(header)).toBe(key);
  });
});

describe('readCsvTable', () => {
  it('names each row’s cells by column, trimmed, with spreadsheet row numbers', () => {
    const table = readCsvTable('SKU, Pack Size \n AP-1L ,1\n,\nAP-4L\n');

    expect(table).toEqual({
      columns: ['sku', 'pack_size'],
      rows: [
        { row: 2, values: { sku: 'AP-1L', pack_size: '1' } },
        { row: 4, values: { sku: 'AP-4L', pack_size: '' } },
      ],
    });
  });

  it('allows blank extra cells, which Excel sometimes writes', () => {
    expect(readCsvTable('a\n1,,\n').rows).toEqual([{ row: 2, values: { a: '1' } }]);
  });

  it.each([
    ['', 'The file is empty; the first row must name the columns'],
    [' , \n1,2', 'The file is empty; the first row must name the columns'],
    ['a,,b\n', 'Column 2 has no name'],
    ['SKU,sku\n', 'The column "sku" appears twice'],
    ['a\n1,2\n', 'Row 2 has more values than there are columns'],
  ])('refuses %j', (text, message) => {
    expect(() => readCsvTable(text)).toThrow(message);
  });
});
