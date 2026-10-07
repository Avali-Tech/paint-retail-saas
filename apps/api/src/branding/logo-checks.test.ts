import { describe, expect, it } from 'vitest';
import { PDF, PNG } from '../test-support/files.js';
import { SCRIPTED_SVG, jpegHeader, pngImage, webpHeader } from '../test-support/images.js';
import { MAX_LOGO_SIDE, MIN_LOGO_SIDE, checkLogo, looksLikeSvg } from './logo-checks.js';

describe('checkLogo', () => {
  it('accepts PNG, JPEG and WebP logos, reading their size from the bytes', () => {
    expect(checkLogo(pngImage(120, 40))).toEqual({
      ok: true,
      logo: { contentType: 'image/png', extension: 'png', width: 120, height: 40 },
    });
    expect(checkLogo(jpegHeader(300, 100))).toEqual({
      ok: true,
      logo: { contentType: 'image/jpeg', extension: 'jpg', width: 300, height: 100 },
    });
    // A progressive JPEG's frame marker is C2.
    expect(checkLogo(jpegHeader(64, 64, 0xc2))).toMatchObject({ ok: true });
    for (const kind of ['VP8 ', 'VP8L', 'VP8X'] as const) {
      expect(checkLogo(webpHeader(kind, 256, 128)), kind).toEqual({
        ok: true,
        logo: { contentType: 'image/webp', extension: 'webp', width: 256, height: 128 },
      });
    }
  });

  it('refuses SVG, even disguised behind a byte-order mark, spaces or an XML declaration', () => {
    expect(checkLogo(SCRIPTED_SVG)).toEqual({ ok: false, code: 'svg_not_allowed' });
    expect(checkLogo(Buffer.from('<svg viewBox="0 0 1 1"/>'))).toEqual({
      ok: false,
      code: 'svg_not_allowed',
    });
  });

  it('refuses other markup and documents as the wrong kind of file', () => {
    expect(looksLikeSvg(Buffer.from('<html><body>svg</body></html>'))).toBe(false);
    for (const file of [
      Buffer.from('<html><script></script></html>'),
      PDF,
      Buffer.from('GIF89a'),
    ]) {
      expect(checkLogo(file)).toEqual({ ok: false, code: 'file_type' });
    }
  });

  it('refuses pictures whose size cannot be read', () => {
    const cut = (data: Buffer, length: number) => data.subarray(0, length);
    for (const file of [
      PNG, // too short for a header
      Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(20)]), // no IHDR chunk
      cut(jpegHeader(10, 10), 12),
      Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(20)]), // not a segment
      cut(webpHeader('VP8 ', 10, 10), 20),
      webpHeader('ALPH', 10, 10), // no image chunk first
    ]) {
      expect(checkLogo(file)).toEqual({ ok: false, code: 'file_type' });
    }
  });

  it('refuses logos too small to see or too large to send to phones', () => {
    expect(checkLogo(pngImage(MIN_LOGO_SIDE - 1, 40))).toEqual({ ok: false, code: 'dimensions' });
    expect(checkLogo(jpegHeader(MAX_LOGO_SIDE + 1, 100))).toEqual({
      ok: false,
      code: 'dimensions',
    });
    expect(checkLogo(pngImage(MIN_LOGO_SIDE, MIN_LOGO_SIDE))).toMatchObject({ ok: true });
  });
});
