import type { LogoUploadErrorCode } from '@paint/shared';
import { detectFileType } from '../documents/file-checks.js';

/** A logo is shown at a few dozen pixels: 1 MB is plenty for a sharp PNG. */
export const MAX_LOGO_BYTES = 1024 * 1024;
/** Smaller than this looks blurred in the header; larger only wastes phones' data. */
export const MIN_LOGO_SIDE = 16;
export const MAX_LOGO_SIDE = 2048;

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export interface CheckedLogo {
  readonly contentType: string;
  readonly extension: string;
  readonly width: number;
  readonly height: number;
}

export type LogoCheck =
  | { readonly ok: true; readonly logo: CheckedLogo }
  | {
      readonly ok: false;
      readonly code: Extract<LogoUploadErrorCode, 'file_type' | 'svg_not_allowed' | 'dimensions'>;
    };

interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * Whether the file is SVG (or other markup) rather than a picture. SVG is never
 * accepted: it is a document that can carry scripts, event handlers and links to
 * other sites, and no sanitiser we could run here is worth that risk for a logo.
 */
export function looksLikeSvg(data: Buffer): boolean {
  const head = data.toString('utf8', 0, 1024).trimStart().toLowerCase();
  return head.startsWith('<') && head.includes('<svg');
}

/** PNG: the IHDR chunk, always first, holds the size. */
function pngSize(data: Buffer): Size | null {
  if (data.length < 24 || data.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** Start-of-frame markers (C0–CF, but C4, C8 and CC are other segments) hold the size. */
const START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const isStartOfFrame = (marker: number) => START_OF_FRAME.has(marker);

/** JPEG: walks the segments after the start marker to the first start of frame. */
function jpegSize(data: Buffer): Size | null {
  let offset = 2;
  while (offset + 9 <= data.length && data[offset] === 0xff) {
    const marker = Number(data[offset + 1]);
    if (isStartOfFrame(marker)) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + data.readUInt16BE(offset + 2);
  }
  return null;
}

/** WebP: lossy (VP8), lossless (VP8L) or extended (VP8X) store the size differently. */
function webpSize(data: Buffer): Size | null {
  if (data.length < 30) return null;
  const chunk = data.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = data.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
  }
  return null;
}

const SIZE_READERS: Record<string, (data: Buffer) => Size | null> = {
  'image/png': pngSize,
  'image/jpeg': jpegSize,
  'image/webp': webpSize,
};

/**
 * Checks a logo from its bytes, like documents (the browser's claimed type is
 * ignored): a PNG, JPEG or WebP whose header gives a size between MIN_LOGO_SIDE
 * and MAX_LOGO_SIDE on each side. The file is stored as uploaded, never decoded.
 */
export function checkLogo(data: Buffer): LogoCheck {
  if (looksLikeSvg(data)) return { ok: false, code: 'svg_not_allowed' };
  const type = detectFileType(data, '');
  if (!type || !LOGO_TYPES.includes(type.contentType)) return { ok: false, code: 'file_type' };
  const size = SIZE_READERS[type.contentType]?.(data);
  if (!size) return { ok: false, code: 'file_type' };
  const sides = [size.width, size.height];
  if (sides.some((side) => side < MIN_LOGO_SIDE || side > MAX_LOGO_SIDE)) {
    return { ok: false, code: 'dimensions' };
  }
  return {
    ok: true,
    logo: { contentType: type.contentType, extension: String(type.extensions[0]), ...size },
  };
}
