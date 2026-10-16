import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Statement files for brand statement tests (P2-M34): CSV text, and Excel workbooks
 * written as Excel writes them (deflated, shared strings, numbers and dates as numbers)
 * or as simpler tools do (stored, inline strings).
 */

/** A CSV file of the rows, quoting where needed. */
export function csvFile(rows: readonly (readonly string[])[]): Buffer {
  const quote = (value: string) =>
    /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return Buffer.from(rows.map((row) => row.map(quote).join(',')).join('\r\n'));
}

/** A ZIP archive of the entries, each stored or deflated. */
export function zipOf(
  entries: readonly { name: string; data: Buffer }[],
  deflate: boolean,
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const fileName = Buffer.from(name);
    const body = deflate ? deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, body);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const escape = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const columnName = (index: number) => {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
};

/**
 * An .xlsx workbook whose first sheet holds the rows: numbers as numbers, text as shared
 * strings (Excel's way) or inline strings, deflated or stored. A null cell is left out.
 */
export function xlsxFile(
  rows: readonly (readonly (string | number | boolean | null)[])[],
  { deflate = true, sharedStrings = true, sheetPath = 'worksheets/sheet1.xml' } = {},
): Buffer {
  const shared: string[] = [];
  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const ref = `${columnName(columnIndex)}${String(rowIndex + 1)}`;
          if (value === null) return '';
          if (typeof value === 'number') return `<c r="${ref}"><v>${String(value)}</v></c>`;
          if (typeof value === 'boolean')
            return `<c r="${ref}" t="b"><v>${value ? '1' : '0'}</v></c>`;
          if (!sharedStrings)
            return `<c r="${ref}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`;
          let index = shared.indexOf(value);
          if (index === -1) index = shared.push(value) - 1;
          return `<c r="${ref}" t="s"><v>${String(index)}</v></c>`;
        })
        .join('');
      return `<row r="${String(rowIndex + 1)}">${cells}</row>`;
    })
    .join('');
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const entries = [
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<?xml version="1.0"?><workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="Ledger" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="${sheetPath}"/></Relationships>`,
      ),
    },
    {
      name: sheetPath.startsWith('/') ? sheetPath.slice(1) : `xl/${sheetPath}`,
      data: Buffer.from(
        `<?xml version="1.0"?><worksheet xmlns="${main}"><sheetData>${sheetRows}</sheetData></worksheet>`,
      ),
    },
    ...(sharedStrings
      ? [
          {
            name: 'xl/sharedStrings.xml',
            data: Buffer.from(
              `<?xml version="1.0"?><sst xmlns="${main}">${shared.map((text) => `<si><t xml:space="preserve">${escape(text)}</t></si>`).join('')}</sst>`,
            ),
          },
        ]
      : []),
  ];
  return zipOf(entries, deflate);
}
