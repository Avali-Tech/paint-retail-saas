import type { DocumentFile } from '../api/documents.js';
import { PARTY } from './party-fixtures.js';

export const DOCUMENT: DocumentFile = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  recordType: 'party',
  recordId: PARTY.id,
  category: 'gst_certificate',
  fileName: 'gst.pdf',
  contentType: 'application/pdf',
  note: null,
  sizeBytes: 122_880,
  sha256: 'a'.repeat(64),
  uploadedBy: { memberId: 'member-1', name: 'Anil Kumar' },
  createdAt: '2026-09-02T06:00:00.000Z',
};

/** A file's first bytes, as the API recognises each accepted kind. */
export const FILE_HEADS = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff, 0xe0],
  webp: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  heic: [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63],
  zip: [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00],
  text: [0x68, 0x65, 0x6c, 0x6c, 0x6f],
} as const;

/** A File with these first bytes. */
export function fileOf(name: string, head: readonly number[], type = ''): File {
  return new File([new Uint8Array(head)], name, { type });
}
