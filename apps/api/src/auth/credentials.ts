import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';

// scrypt parameters (OWASP-recommended range). Stored inside every hash so they
// can be raised later without breaking existing passwords.
const LOG_N = 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 64;

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const deriveKey = (password: string, salt: Buffer, options: ScryptOptions) =>
  scryptAsync(password, salt, KEY_LENGTH, options);

const scryptOptions = (logN: number, r: number, p: number): ScryptOptions => ({
  N: 2 ** logN,
  r,
  p,
  maxmem: 256 * 2 ** logN * r,
});

/** Hashes a password as `scrypt$logN$r$p$salt$hash` (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, scryptOptions(LOG_N, BLOCK_SIZE, PARALLELISM));
  return [
    'scrypt',
    LOG_N,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

const STORED_HASH = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([\w-]+)\$([\w-]+)$/;

/** Checks a password against a stored hash in constant time. False for malformed hashes. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = STORED_HASH.exec(stored);
  if (!match) return false;
  const [, logN, r, p, salt, hash] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const expected = Buffer.from(hash, 'base64url');
  if (expected.length !== KEY_LENGTH) return false;
  const key = await deriveKey(
    password,
    Buffer.from(salt, 'base64url'),
    scryptOptions(Number(logN), Number(r), Number(p)),
  );
  return timingSafeEqual(key, expected);
}

/** A random, URL-safe session token (256 bits). Given to the client once, never stored. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 of a session token: what the database stores and looks up. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A 6-digit one-time code, leading zeros kept (e.g. "004217"). */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Keyed hash of a one-time code, bound to the phone number. A 6-digit code is
 * easy to brute-force from a plain hash, so the server secret is required.
 */
export function hashOtpCode(secret: string, phone: string, code: string): string {
  return createHmac('sha256', secret).update(`${phone}:${code}`).digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
