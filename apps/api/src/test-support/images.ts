import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real, valid PNG of one solid colour (browsers show it), `width` × `height` pixels. */
export function pngImage(
  width: number,
  height: number,
  rgb: [number, number, number] = [200, 40, 40],
) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill(rgb).flat())]);
  const pixels = Buffer.concat(Array<Buffer>(height).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The start of a JPEG: an APP0 segment, a quantisation table, then the frame with its size. */
export function jpegHeader(width: number, height: number, frameMarker = 0xc0): Buffer {
  const app0 = Buffer.from([
    0xff,
    0xe0,
    0x00,
    0x10,
    ...Buffer.from('JFIF\0'),
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ]);
  const dqt = Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x00]);
  const frame = Buffer.alloc(19);
  frame.writeUInt8(0xff, 0);
  frame.writeUInt8(frameMarker, 1);
  frame.writeUInt16BE(17, 2);
  frame.writeUInt8(8, 4);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dqt, frame]);
}

/** The start of a WebP file of the given kind holding the size. */
export function webpHeader(kind: 'VP8 ' | 'VP8L' | 'VP8X' | 'ALPH', width: number, height: number) {
  const data = Buffer.alloc(40);
  data.write('RIFF', 0, 'latin1');
  data.writeUInt32LE(32, 4);
  data.write('WEBP', 8, 'latin1');
  data.write(kind, 12, 'latin1');
  if (kind === 'VP8 ') {
    data.writeUInt16LE(width, 26);
    data.writeUInt16LE(height, 28);
  } else if (kind === 'VP8L') {
    data.writeUInt8(0x2f, 20);
    data.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  } else {
    data.writeUIntLE(width - 1, 24, 3);
    data.writeUIntLE(height - 1, 27, 3);
  }
  return data;
}

/** An SVG logo carrying a script and an event handler: what an attacker would upload. */
export const SCRIPTED_SVG = Buffer.from(
  '﻿  <?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>fetch("/api/auth/me")</script></svg>',
);
