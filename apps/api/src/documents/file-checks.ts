/** The largest file we accept: enough for a scanned certificate or a phone photo. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const ALLOWED_FILES_MESSAGE =
  'Upload a PDF, a photo (JPG, PNG, WebP or HEIC) or a Word or Excel file';

export interface DetectedType {
  readonly contentType: string;
  /** Accepted extensions; the first is used when the name lacks one. */
  readonly extensions: readonly string[];
}

const PDF: DetectedType = { contentType: 'application/pdf', extensions: ['pdf'] };
const PNG: DetectedType = { contentType: 'image/png', extensions: ['png'] };
const JPEG: DetectedType = { contentType: 'image/jpeg', extensions: ['jpg', 'jpeg'] };
const WEBP: DetectedType = { contentType: 'image/webp', extensions: ['webp'] };
const HEIC: DetectedType = { contentType: 'image/heic', extensions: ['heic', 'heif'] };
const DOCX: DetectedType = {
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  extensions: ['docx'],
};
const XLSX: DetectedType = {
  contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  extensions: ['xlsx'],
};
const HEIC_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'mif1'];

const bytesAt = (data: Buffer, offset: number, expected: string | number[]) => {
  const wanted =
    typeof expected === 'string' ? Buffer.from(expected, 'latin1') : Buffer.from(expected);
  return data.subarray(offset, offset + wanted.length).equals(wanted);
};

/**
 * Works out what a file really is from its first bytes, ignoring the type the
 * browser claimed. Word and Excel files are ZIP archives, told apart by name.
 * Returns null for anything we do not accept.
 */
export function detectFileType(data: Buffer, fileName: string): DetectedType | null {
  if (bytesAt(data, 0, '%PDF-')) return PDF;
  if (bytesAt(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG;
  if (bytesAt(data, 0, [0xff, 0xd8, 0xff])) return JPEG;
  if (bytesAt(data, 0, 'RIFF') && bytesAt(data, 8, 'WEBP')) return WEBP;
  if (bytesAt(data, 4, 'ftyp') && HEIC_BRANDS.includes(data.toString('latin1', 8, 12))) {
    return HEIC;
  }
  if (bytesAt(data, 0, [0x50, 0x4b, 0x03, 0x04])) {
    const name = fileName.toLowerCase();
    if (name.endsWith('.docx')) return DOCX;
    if (name.endsWith('.xlsx')) return XLSX;
  }
  return null;
}

// Control characters, and the bidirectional overrides used to disguise
// "invoice‮fdp.exe" as "invoiceexe.pdf".
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * A file name that is safe to store and show: no folders, no control or
 * direction characters, at most 120 characters, ending in an extension that
 * matches what the file really is.
 */
export function cleanFileName(name: string, type: DetectedType): string {
  const base = name
    .replace(/^.*[\\/]/, '')
    .replace(/\s+/g, ' ')
    .replace(UNSAFE, '')
    .trim();
  const lower = base.toLowerCase();
  const matches = type.extensions.some((extension) => lower.endsWith(`.${extension}`));
  const withExtension = matches ? base : `${base || 'document'}.${String(type.extensions[0])}`;
  if (withExtension.length <= 120) return withExtension;
  const dot = withExtension.lastIndexOf('.');
  const extension = withExtension.slice(dot);
  return `${withExtension.slice(0, 120 - extension.length)}${extension}`;
}

/** A Content-Disposition header that downloads the file under its name, in any language. */
export function attachmentHeader(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
