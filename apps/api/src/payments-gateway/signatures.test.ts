import { describe, expect, it } from 'vitest';
import { hmacHex, signatureMatches } from './signatures.js';

describe('hmacHex', () => {
  it('is the hex HMAC-SHA256 of the body (RFC 4231 test case 2)', () => {
    expect(hmacHex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
});

describe('signatureMatches', () => {
  it('compares HMACs in constant time and refuses anything but a string', () => {
    const body = Buffer.from('{}');
    expect(signatureMatches('s', body, hmacHex('s', body))).toBe(true);
    expect(signatureMatches('s', body, hmacHex('t', body))).toBe(false);
    expect(signatureMatches('s', body, 'short')).toBe(false);
    expect(signatureMatches('s', body, ['x'])).toBe(false);
  });
});
