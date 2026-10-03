import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
} from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238) on HOTP (RFC 4226), as used by
 * Google Authenticator, Microsoft Authenticator, Authy and 1Password: SHA-1,
 * 6 digits, 30-second steps.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, without padding, as authenticator apps expect. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

/** Decodes base32, ignoring case, spaces and padding; throws on other characters. */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new TypeError(`Not base32: "${char}"`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

/** HOTP (RFC 4226): the code for one counter value. */
export function hotp(
  secret: Buffer,
  counter: bigint,
  digits = 6,
  algorithm: TotpAlgorithm = 'sha1',
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac(algorithm, secret).update(message).digest();
  // Dynamic truncation: the low 4 bits of the last byte pick 4 bytes.
  const offset = Number(digest.at(-1)) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const TOTP_STEP_SECONDS = 30;

/** The time step a moment falls in. */
export function totpStep(nowMs: number): bigint {
  return BigInt(Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
}

/** TOTP (RFC 6238): the code for a moment. */
export function totp(
  secret: Buffer,
  nowMs: number,
  digits = 6,
  algorithm: TotpAlgorithm = 'sha1',
): string {
  return hotp(secret, totpStep(nowMs), digits, algorithm);
}

/**
 * Checks a 6-digit code, allowing one step either side for clock drift.
 * Returns the step it matched, or null. Steps at or before `lastUsedStep` are
 * refused, so a code cannot be used twice.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  nowMs: number,
  lastUsedStep: bigint | null,
): bigint | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(nowMs);
  for (const step of [current - 1n, current, current + 1n]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (hotp(secret, step) === code) return step;
  }
  return null;
}

/** A new 160-bit secret, the size RFC 4226 recommends for SHA-1. */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

/** The otpauth:// URI an authenticator app reads from a QR code. */
export function otpauthUri(issuer: string, account: string, secret: Buffer): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const query = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

const keyFor = (serverSecret: string) =>
  Buffer.from(hkdfSync('sha256', serverSecret, 'paint-retail', 'totp-secret', 32));

/** Encrypts a TOTP secret for storage (AES-256-GCM, key derived from the server secret). */
export function sealSecret(serverSecret: string, secret: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(serverSecret), iv);
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), body].map((part) => part.toString('base64url')).join('.');
}

/** Decrypts a stored TOTP secret; throws if it was tampered with or the key differs. */
export function openSecret(serverSecret: string, sealed: string): Buffer {
  const [version, iv = '', tag = '', body = ''] = sealed.split('.');
  if (version !== 'v1') throw new TypeError('Unknown secret format');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyFor(serverSecret),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]);
}

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Ten one-time recovery codes like "k7pq-2mxa", for when the phone is lost. */
export function generateRecoveryCodes(count = 10): string[] {
  const part = () =>
    Array.from({ length: 4 }, () =>
      RECOVERY_ALPHABET.charAt(randomInt(RECOVERY_ALPHABET.length)),
    ).join('');
  return Array.from({ length: count }, () => `${part()}-${part()}`);
}

/** How a recovery code is stored: keyed hash of the code as typed, ignoring case, spaces and dashes. */
export function hashRecoveryCode(serverSecret: string, code: string): string {
  const normal = code.toLowerCase().replace(/[\s-]/g, '');
  return createHmac('sha256', serverSecret).update(`recovery:${normal}`).digest('hex');
}
