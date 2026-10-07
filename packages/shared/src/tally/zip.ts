import { at } from '../gst/arith.js';

/**
 * A minimal ZIP writer (PKWARE APPNOTE 6.3.10): entries are stored, not
 * compressed, and stamped 1980-01-01 00:00, so the same files always give the
 * same bytes. Enough for an .xlsx; no dependency, and it runs in a browser too.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** CRC-32 (IEEE 802.3), as ZIP and PNG use it. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = at(CRC_TABLE, (crc ^ byte) & 0xff) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  readonly path: string;
  readonly data: Uint8Array;
}

/** DOS date for 1980-01-01: ((1980 − 1980) << 9) | (1 << 5) | 1. */
const DOS_DATE = 0x0021;
/** Bit 11: file names are UTF-8. */
const UTF8_FLAG = 0x0800;

class Writer {
  private readonly chunks: Uint8Array[] = [];
  length = 0;

  bytes(data: Uint8Array) {
    this.chunks.push(data);
    this.length += data.length;
  }

  u16(value: number) {
    this.bytes(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }

  u32(value: number) {
    this.bytes(
      new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24]),
    );
  }

  result(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/** Packs the entries, in the order given, into one ZIP archive. */
export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const out = new Writer();
  const central = new Writer();
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const crc = crc32(entry.data);
    const offset = out.length;
    const header = (writer: Writer, centralRecord: boolean) => {
      writer.u32(centralRecord ? 0x02014b50 : 0x04034b50);
      if (centralRecord) writer.u16(20); // version made by: 2.0
      writer.u16(20); // version needed to extract: 2.0
      writer.u16(UTF8_FLAG);
      writer.u16(0); // method: stored
      writer.u16(0); // time 00:00:00
      writer.u16(DOS_DATE);
      writer.u32(crc);
      writer.u32(entry.data.length); // compressed size
      writer.u32(entry.data.length); // uncompressed size
      writer.u16(name.length);
      writer.u16(0); // extra field length
      if (centralRecord) {
        writer.u16(0); // comment length
        writer.u16(0); // disk number
        writer.u16(0); // internal attributes
        writer.u32(0); // external attributes
        writer.u32(offset);
      }
      writer.bytes(name);
    };
    header(out, false);
    out.bytes(entry.data);
    header(central, true);
  }
  const centralOffset = out.length;
  out.bytes(central.result());
  out.u32(0x06054b50); // end of central directory
  out.u16(0);
  out.u16(0);
  out.u16(entries.length);
  out.u16(entries.length);
  out.u32(central.length);
  out.u32(centralOffset);
  out.u16(0);
  return out.result();
}
