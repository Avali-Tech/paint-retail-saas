import { ApiError } from '../api/errors.js';

// The API's upload rules (apps/api/src/documents/file-checks.ts), checked before
// sending so people hear at once what is wrong; the API checks again.

/** The largest file the API accepts. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** For the file input: the kinds the API accepts, by extension and type. */
export const ACCEPTED_FILES = [
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.heif',
  '.docx',
  '.xlsx',
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
].join(',');

const HEIC_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'mif1'];

const at = (bytes: Uint8Array, offset: number, expected: string | readonly number[]) => {
  const wanted =
    typeof expected === 'string' ? Array.from(new TextEncoder().encode(expected)) : expected;
  return wanted.every((byte, index) => bytes[offset + index] === byte);
};

/**
 * Whether the API will accept the file, judged like the API does: from its first
 * bytes, ignoring its claimed type. Word and Excel files are ZIP archives, told
 * apart by name.
 */
export function isAcceptedFile(head: Uint8Array, fileName: string): boolean {
  const name = fileName.toLowerCase();
  return (
    at(head, 0, '%PDF-') ||
    at(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    at(head, 0, [0xff, 0xd8, 0xff]) ||
    (at(head, 0, 'RIFF') && at(head, 8, 'WEBP')) ||
    (at(head, 4, 'ftyp') && HEIC_BRANDS.some((brand) => at(head, 8, brand))) ||
    (at(head, 0, [0x50, 0x4b, 0x03, 0x04]) && (name.endsWith('.docx') || name.endsWith('.xlsx')))
  );
}

export type FileProblem = 'empty' | 'tooBig' | 'type';

/** What is wrong with a file before uploading it, or null when the API should accept it. */
export async function checkFile(file: File): Promise<FileProblem | null> {
  if (file.size === 0) return 'empty';
  if (file.size > MAX_DOCUMENT_BYTES) return 'tooBig';
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  return isAcceptedFile(head, file.name) ? null : 'type';
}

export type UploadRefusal = 'scannerOff' | 'storageOff' | 'type' | 'tooBig' | 'infected';

/** Why the API refused an upload, when it is one of the refusals people can act on. */
export function uploadRefusal(error: unknown): UploadRefusal | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.status) {
    case 503:
      // Both "virus scanning is unavailable" and "storage is not set up" answer 503.
      return /virus/i.test(error.message) ? 'scannerOff' : 'storageOff';
    case 415:
      return 'type';
    case 413:
      return 'tooBig';
    case 422:
      return 'infected';
    default:
      return null;
  }
}

/** A file size in whole bytes, kilobytes or megabytes (one decimal). */
export function sizeParts(bytes: number): { unit: 'B' | 'KB' | 'MB'; size: number } {
  if (bytes < 1024) return { unit: 'B', size: bytes };
  if (bytes < 1024 * 1024) return { unit: 'KB', size: Math.round(bytes / 1024) };
  return { unit: 'MB', size: Math.round((bytes / 1024 / 1024) * 10) / 10 };
}
