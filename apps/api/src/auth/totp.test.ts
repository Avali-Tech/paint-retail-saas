import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  openSecret,
  otpauthUri,
  sealSecret,
  totp,
  totpStep,
  verifyTotp,
} from './totp.js';

// RFC 6238 appendix B seeds: the ASCII digits, repeated to the hash's key size.
const SHA1_KEY = Buffer.from('12345678901234567890');
const SHA256_KEY = Buffer.from('12345678901234567890123456789012');
const SHA512_KEY = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234');

describe('TOTP against the RFC 6238 test vectors', () => {
  it.each([
    [59, '94287082', '46119246', '90693936'],
    [1_111_111_109, '07081804', '68084774', '25091201'],
    [1_111_111_111, '14050471', '67062674', '99943326'],
    [1_234_567_890, '89005924', '91819424', '93441116'],
    [2_000_000_000, '69279037', '90698825', '38618901'],
    [20_000_000_000, '65353130', '77737706', '47863826'],
  ])('at %i seconds', (seconds, sha1, sha256, sha512) => {
    const now = seconds * 1000;
    expect(totp(SHA1_KEY, now, 8, 'sha1')).toBe(sha1);
    expect(totp(SHA256_KEY, now, 8, 'sha256')).toBe(sha256);
    expect(totp(SHA512_KEY, now, 8, 'sha512')).toBe(sha512);
  });
});

describe('HOTP against the RFC 4226 test vectors', () => {
  it('produces the published codes for counters 0 to 9', () => {
    expect(Array.from({ length: 10 }, (_, i) => hotp(SHA1_KEY, BigInt(i)))).toEqual([
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ]);
  });
});

describe('verifyTotp', () => {
  const now = 1_234_567_890_000;
  const step = totpStep(now);

  it('accepts the current code and one step either side', () => {
    expect(verifyTotp(SHA1_KEY, totp(SHA1_KEY, now), now, null)).toBe(step);
    expect(verifyTotp(SHA1_KEY, totp(SHA1_KEY, now - 30_000), now, null)).toBe(step - 1n);
    expect(verifyTotp(SHA1_KEY, totp(SHA1_KEY, now + 30_000), now, null)).toBe(step + 1n);
    expect(verifyTotp(SHA1_KEY, totp(SHA1_KEY, now - 60_000), now, null)).toBeNull();
  });

  it('refuses a code already used, or older than one used', () => {
    const code = totp(SHA1_KEY, now);
    expect(verifyTotp(SHA1_KEY, code, now, step)).toBeNull();
    expect(verifyTotp(SHA1_KEY, totp(SHA1_KEY, now - 30_000), now, step - 1n)).toBeNull();
    expect(verifyTotp(SHA1_KEY, code, now, step - 1n)).toBe(step);
  });

  it('refuses anything that is not six digits', () => {
    expect(verifyTotp(SHA1_KEY, '12345', now, null)).toBeNull();
    expect(verifyTotp(SHA1_KEY, 'abcdef', now, null)).toBeNull();
    expect(verifyTotp(SHA1_KEY, ` ${totp(SHA1_KEY, now)}`, now, null)).toBeNull();
  });
});

describe('base32', () => {
  it('matches RFC 4648 and round-trips', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
    expect(base32Encode(Buffer.from(''))).toBe('');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw 6ytb oi==').toString()).toBe('foobar');
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(20);
    expect(base32Decode(base32Encode(secret))).toEqual(secret);
  });

  it('refuses characters outside the alphabet', () => {
    expect(() => base32Decode('MZ1W')).toThrow(TypeError);
  });
});

describe('otpauthUri', () => {
  it('names the business and account for the authenticator app', () => {
    const uri = otpauthUri('Paint Retail', 'anil@abc.example', Buffer.from('foobar'));

    expect(uri).toBe(
      'otpauth://totp/Paint%20Retail%3Aanil%40abc.example?secret=MZXW6YTBOI&issuer=Paint+Retail&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('stored secrets', () => {
  const server = 'a-server-secret-of-at-least-32-characters';

  it('are encrypted, different every time, and open with the same key only', () => {
    const secret = generateTotpSecret();
    const first = sealSecret(server, secret);
    const second = sealSecret(server, secret);

    expect(first).not.toBe(second);
    expect(first).not.toContain(base32Encode(secret));
    expect(openSecret(server, first)).toEqual(secret);
    expect(() => openSecret('another-server-secret-of-32-characters!', first)).toThrow();
  });

  it('refuses tampered or unknown formats', () => {
    const sealed = sealSecret(server, generateTotpSecret());
    const [version, iv, tag, body] = sealed.split('.');
    const flipped = `${String(version)}.${String(iv)}.${String(tag)}.${String(body).replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))}`;

    expect(() => openSecret(server, flipped)).toThrow();
    expect(() => openSecret(server, `v2.${String(iv)}`)).toThrow('Unknown secret format');
    expect(() => openSecret(server, 'v1')).toThrow();
  });
});

describe('recovery codes', () => {
  it('are ten distinct readable codes, hashed however they are typed', () => {
    const codes = generateRecoveryCodes();
    const server = 'a-server-secret-of-at-least-32-characters';

    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-km-np-z2-9]{4}-[a-km-np-z2-9]{4}$/);
    const [code = ''] = codes;
    expect(hashRecoveryCode(server, code)).toBe(
      hashRecoveryCode(server, ` ${code.toUpperCase().replace('-', ' ')} `),
    );
    expect(hashRecoveryCode(server, code)).not.toBe(
      hashRecoveryCode('other-secret-xxxxxxxxxxxxxxxxxxxxxx', code),
    );
    expect(generateRecoveryCodes(3)).toHaveLength(3);
  });
});
