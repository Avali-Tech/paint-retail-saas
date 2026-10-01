import { describe, expect, it } from 'vitest';
import { attachmentHeader, cleanFileName, detectFileType } from './file-checks.js';

const bytes = (...parts: (string | number[])[]) =>
  Buffer.concat(
    parts.map((part) =>
      typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part),
    ),
  );
const PDF = bytes('%PDF-1.7\n...');
const ZIP = bytes([0x50, 0x4b, 0x03, 0x04], 'rest');

describe('detectFileType', () => {
  it.each([
    [PDF, 'x', 'application/pdf'],
    [bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'IHDR'), 'x', 'image/png'],
    [bytes([0xff, 0xd8, 0xff, 0xe0]), 'x', 'image/jpeg'],
    [bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '), 'x', 'image/webp'],
    [bytes([0, 0, 0, 0x18], 'ftypheic'), 'x', 'image/heic'],
    [bytes([0, 0, 0, 0x18], 'ftypmif1'), 'x', 'image/heic'],
    [
      ZIP,
      'Agreement.DOCX',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    [ZIP, 'rates.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ])('recognises %#: %s', (data, name, contentType) => {
    expect(detectFileType(data, name)?.contentType).toBe(contentType);
  });

  it.each([
    [bytes('<html><script>alert(1)</script>'), 'invoice.pdf'],
    [bytes('MZ'), 'setup.exe'],
    [ZIP, 'archive.zip'],
    [bytes('RIFF', [0, 0, 0, 0], 'WAVE'), 'sound.webp'],
    [bytes([0, 0, 0, 0x18], 'ftypisom'), 'video.heic'],
    [bytes('%PD'), 'short.pdf'],
    [Buffer.alloc(0), 'empty.pdf'],
  ])('refuses anything else, whatever its name: %#', (data, name) => {
    expect(detectFileType(data, name)).toBeNull();
  });
});

describe('cleanFileName', () => {
  const pdf = { contentType: 'application/pdf', extensions: ['pdf'] };
  const jpeg = { contentType: 'image/jpeg', extensions: ['jpg', 'jpeg'] };

  it.each([
    ['GST Certificate.pdf', pdf, 'GST Certificate.pdf'],
    ['C:\\Users\\raj\\Desktop\\pan.pdf', pdf, 'pan.pdf'],
    ['../../etc/passwd', pdf, 'passwd.pdf'],
    ['shop\tfront\n photo.JPEG', jpeg, 'shop front photo.JPEG'],
    ['invoice\u202Efdp.exe', pdf, 'invoicefdp.exe.pdf'],
    ['', jpeg, 'document.jpg'],
    ['   ', pdf, 'document.pdf'],
    ['जीएसटी प्रमाणपत्र.pdf', pdf, 'जीएसटी प्रमाणपत्र.pdf'],
  ])('%j → %j', (name, type, expected) => {
    expect(cleanFileName(name, type)).toBe(expected);
  });

  it('shortens long names to 120 characters, keeping the extension', () => {
    const cleaned = cleanFileName(`${'a'.repeat(200)}.pdf`, pdf);

    expect(cleaned).toHaveLength(120);
    expect(cleaned.endsWith('a.pdf')).toBe(true);
  });
});

describe('attachmentHeader', () => {
  it('always downloads, with a plain fallback and the exact name for modern browsers', () => {
    expect(attachmentHeader('GST "copy".pdf')).toBe(
      `attachment; filename="GST _copy_.pdf"; filename*=UTF-8''GST%20%22copy%22.pdf`,
    );
    expect(attachmentHeader('पैन.pdf')).toBe(
      `attachment; filename="___.pdf"; filename*=UTF-8''%E0%A4%AA%E0%A5%88%E0%A4%A8.pdf`,
    );
  });
});
