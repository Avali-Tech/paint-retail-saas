import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors.js';
import { FILE_HEADS, fileOf } from '../test-support/document-fixtures.js';
import {
  MAX_DOCUMENT_BYTES,
  checkFile,
  isAcceptedFile,
  sizeParts,
  uploadRefusal,
} from './file-checks.js';

const bytes = (head: readonly number[]) => new Uint8Array(head);

describe('isAcceptedFile', () => {
  it('accepts the kinds the API accepts, judged by their bytes', () => {
    expect(isAcceptedFile(bytes(FILE_HEADS.pdf), 'scan')).toBe(true);
    expect(isAcceptedFile(bytes(FILE_HEADS.png), 'photo.jpg')).toBe(true);
    expect(isAcceptedFile(bytes(FILE_HEADS.jpeg), 'photo')).toBe(true);
    expect(isAcceptedFile(bytes(FILE_HEADS.webp), 'photo.webp')).toBe(true);
    expect(isAcceptedFile(bytes(FILE_HEADS.heic), 'IMG_0001.HEIC')).toBe(true);
    expect(isAcceptedFile(bytes(FILE_HEADS.zip), 'Quote.DOCX')).toBe(true);
    expect(isAcceptedFile(bytes(FILE_HEADS.zip), 'stock.xlsx')).toBe(true);
  });

  it('refuses everything else, whatever its name', () => {
    expect(isAcceptedFile(bytes(FILE_HEADS.text), 'invoice.pdf')).toBe(false);
    expect(isAcceptedFile(bytes(FILE_HEADS.zip), 'archive.zip')).toBe(false);
    // RIFF without WEBP is a WAV or AVI.
    expect(
      isAcceptedFile(bytes([...FILE_HEADS.webp.slice(0, 8), 0x57, 0x41, 0x56, 0x45]), 'a.webp'),
    ).toBe(false);
    // An MP4 has ftyp but not a HEIC brand.
    expect(
      isAcceptedFile(
        bytes([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
        'a.heic',
      ),
    ).toBe(false);
    expect(isAcceptedFile(bytes([]), 'empty.pdf')).toBe(false);
  });
});

describe('checkFile', () => {
  it('says what is wrong before uploading', async () => {
    await expect(checkFile(fileOf('gst.pdf', FILE_HEADS.pdf))).resolves.toBeNull();
    await expect(checkFile(fileOf('empty.pdf', []))).resolves.toBe('empty');
    await expect(checkFile(fileOf('notes.txt', FILE_HEADS.text))).resolves.toBe('type');
    const big = fileOf('scan.pdf', FILE_HEADS.pdf);
    Object.defineProperty(big, 'size', { value: MAX_DOCUMENT_BYTES + 1 });
    await expect(checkFile(big)).resolves.toBe('tooBig');
  });
});

describe('uploadRefusal', () => {
  it('names the refusals people can act on', () => {
    const refused = (status: number, code: string, message = 'Refused') =>
      uploadRefusal(new ApiError(status, message, [], [], { code }));
    // By the code, whatever the message says.
    expect(refused(503, 'scanner_unavailable', 'Storage trouble')).toBe('scannerOff');
    expect(refused(503, 'storage_unavailable', 'Virus scanner fine')).toBe('storageOff');
    expect(refused(415, 'file_type')).toBe('type');
    expect(refused(413, 'too_large')).toBe('tooBig');
    expect(refused(422, 'virus_found')).toBe('infected');
    expect(refused(400, 'empty_file')).toBe('empty');
    expect(refused(400, 'toString')).toBeNull();
    expect(uploadRefusal(new ApiError(403, 'You cannot change documents'))).toBeNull();
    expect(uploadRefusal(new Error('boom'))).toBeNull();
  });
});

describe('sizeParts', () => {
  it('shows bytes, kilobytes or megabytes', () => {
    expect(sizeParts(900)).toEqual({ unit: 'B', size: 900 });
    expect(sizeParts(122_880)).toEqual({ unit: 'KB', size: 120 });
    expect(sizeParts(2_621_440)).toEqual({ unit: 'MB', size: 2.5 });
  });
});
