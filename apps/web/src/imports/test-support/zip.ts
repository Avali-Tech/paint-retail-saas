// Builds real zip (and so .xlsx) bytes for tests of the spreadsheet reader.

export interface ZipFile {
  readonly name: string;
  readonly text: string;
  /** 0 stored, 8 deflated (default), anything else to test refusals. */
  readonly method?: number;
  /** Writes sizes after the data, as streaming writers (and Excel sometimes) do. */
  readonly dataDescriptor?: boolean;
  readonly encrypted?: boolean;
  /** Replaces the (compressed) bytes, e.g. with garbage. */
  readonly raw?: Uint8Array;
}

const streamOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = streamOf(bytes).pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

class Writer {
  readonly parts: number[] = [];
  u16(value: number) {
    this.parts.push(value & 0xff, (value >>> 8) & 0xff);
  }
  u32(value: number) {
    this.u16(value & 0xffff);
    this.u16((value >>> 16) & 0xffff);
  }
  bytes(values: Uint8Array) {
    this.parts.push(...values);
  }
  get length() {
    return this.parts.length;
  }
}

export async function zip(files: readonly ZipFile[]): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Writer();
  const directory = new Writer();
  for (const file of files) {
    const plain = new TextEncoder().encode(file.text);
    const method = file.method ?? 8;
    const data = file.raw ?? (method === 8 ? await deflate(plain) : plain);
    const name = new TextEncoder().encode(file.name);
    const crc = crc32(plain);
    const flags = (file.dataDescriptor ? 8 : 0) | (file.encrypted ? 1 : 0);
    const offset = out.length;
    out.u32(0x04034b50);
    out.u16(20);
    out.u16(flags);
    out.u16(method);
    out.u32(0);
    out.u32(file.dataDescriptor ? 0 : crc);
    out.u32(file.dataDescriptor ? 0 : data.length);
    out.u32(file.dataDescriptor ? 0 : plain.length);
    out.u16(name.length);
    out.u16(4);
    out.bytes(name);
    out.bytes(new Uint8Array([0xfe, 0xca, 0, 0]));
    out.bytes(data);
    if (file.dataDescriptor) {
      out.u32(0x08074b50);
      out.u32(crc);
      out.u32(data.length);
      out.u32(plain.length);
    }
    directory.u32(0x02014b50);
    directory.u16(20);
    directory.u16(20);
    directory.u16(flags);
    directory.u16(method);
    directory.u32(0);
    directory.u32(crc);
    directory.u32(data.length);
    directory.u32(plain.length);
    directory.u16(name.length);
    directory.u16(0);
    directory.u16(3);
    directory.u16(0);
    directory.u16(0);
    directory.u32(0);
    directory.u32(offset);
    directory.bytes(name);
    directory.bytes(new TextEncoder().encode('abc'));
  }
  const start = out.length;
  out.bytes(new Uint8Array(directory.parts));
  out.u32(0x06054b50);
  out.u16(0);
  out.u16(0);
  out.u16(files.length);
  out.u16(files.length);
  out.u32(directory.length);
  out.u32(start);
  out.u16(2);
  out.bytes(new Uint8Array([0x68, 0x69]));
  return new Uint8Array(out.parts);
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A workbook whose first sheet is at `target`, with optional shared strings. */
export function workbookFiles({
  sheet,
  shared,
  target = 'worksheets/sheet1.xml',
  sheetName = 'xl/worksheets/sheet1.xml',
}: {
  sheet: string;
  shared?: string;
  target?: string;
  sheetName?: string;
}): ZipFile[] {
  return [
    {
      name: 'xl/workbook.xml',
      text: `<?xml version="1.0"?><workbook xmlns="${NS}" xmlns:r="${REL_NS}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Target="styles.xml"/><Relationship Id="rId1" Target="${target}"/></Relationships>`,
    },
    {
      name: sheetName,
      text: `<worksheet xmlns="${NS}"><sheetData>${sheet}</sheetData></worksheet>`,
    },
    ...(shared === undefined
      ? []
      : [{ name: 'xl/sharedStrings.xml', text: `<sst xmlns="${NS}">${shared}</sst>` }]),
  ];
}
