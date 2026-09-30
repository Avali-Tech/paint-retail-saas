import { describe, expect, it } from 'vitest';
import {
  digestsEqual,
  generateOtpCode,
  generateSessionToken,
  hashOtpCode,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from './credentials.js';

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('Rangoli@2026');

    await expect(verifyPassword('Rangoli@2026', stored)).resolves.toBe(true);
    await expect(verifyPassword('rangoli@2026', stored)).resolves.toBe(false);
    await expect(verifyPassword('', stored)).resolves.toBe(false);
  });

  it('records the algorithm and parameters, and salts every hash', async () => {
    const first = await hashPassword('same password');
    const second = await hashPassword('same password');

    expect(first).toMatch(/^scrypt\$15\$8\$1\$[\w-]{22}\$[\w-]{86}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('same password');
  });

  it('still verifies hashes made with other parameters', async () => {
    // A hash made with lighter parameters (logN 14) must keep working after
    // the defaults change.
    const stored = await hashPassword('old password');
    const [, , , , salt] = stored.split('$');
    const { scryptSync } = await import('node:crypto');
    const key = scryptSync('old password', Buffer.from(salt ?? '', 'base64url'), 64, {
      N: 2 ** 14,
      r: 8,
      p: 1,
    });
    const lighter = ['scrypt', 14, 8, 1, salt, key.toString('base64url')].join('$');

    await expect(verifyPassword('old password', lighter)).resolves.toBe(true);
  });

  it.each([
    '',
    'plain-text-password',
    'bcrypt$10$abc$def',
    'scrypt$15$8$1$salt',
    'scrypt$15$8$1$c2FsdA$dG9vLXNob3J0',
  ])('treats a malformed stored hash "%s" as a mismatch', async (stored) => {
    await expect(verifyPassword('anything', stored)).resolves.toBe(false);
  });

  it('rejects when the stored parameters are impossible', async () => {
    const stored = await hashPassword('x');
    const broken = stored.replace(/^scrypt\$15\$8\$1/, 'scrypt$15$0$1');

    await expect(verifyPassword('x', broken)).rejects.toThrow();
  });
});

describe('session tokens', () => {
  it('are long, URL-safe and unique', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateSessionToken));

    expect(tokens.size).toBe(1000);
    for (const token of tokens) expect(token).toMatch(/^[\w-]{43}$/);
  });

  it('hash to a stable SHA-256 hex digest that does not reveal the token', () => {
    const token = generateSessionToken();

    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).not.toContain(token);
    expect(hashSessionToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('one-time codes', () => {
  it('are always 6 digits', () => {
    for (let i = 0; i < 2000; i++) expect(generateOtpCode()).toMatch(/^\d{6}$/);
  });

  it('hash differently per secret, phone and code', () => {
    const base = hashOtpCode('secret-1', '+919800000001', '123456');

    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOtpCode('secret-1', '+919800000001', '123456')).toBe(base);
    expect(hashOtpCode('secret-2', '+919800000001', '123456')).not.toBe(base);
    expect(hashOtpCode('secret-1', '+919800000002', '123456')).not.toBe(base);
    expect(hashOtpCode('secret-1', '+919800000001', '123457')).not.toBe(base);
  });
});

describe('digestsEqual', () => {
  it('compares hex digests', () => {
    expect(digestsEqual('abcd', 'abcd')).toBe(true);
    expect(digestsEqual('abcd', 'abce')).toBe(false);
    expect(digestsEqual('abcd', 'abcdef')).toBe(false);
  });
});
