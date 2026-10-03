import { createHmac } from 'node:crypto';

// An authenticator app for the tests: TOTP (RFC 6238) on HOTP (RFC 4226) with
// SHA-1, 6 digits and 30-second steps, as apps/api/src/auth/totp.ts checks it.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_MS = 30_000;

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.toUpperCase().replace(/[\s=]/g, '')) {
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

/** The time step a moment falls in. */
export const stepAt = (ms: number) => Math.floor(ms / STEP_MS);

/** The 6-digit code for a base32 secret at one time step. */
export function codeForStep(secret: string, step: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = Number(digest.at(-1)) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * A code the API will accept after `lastStep` was used: codes cannot be used
 * twice, and the API allows one step of clock drift either side, so the next
 * step's code works at once. Waits (at most one step) only when even that is used.
 */
export async function nextCode(
  secret: string,
  lastStep: number | null,
): Promise<{ code: string; step: number }> {
  const now = stepAt(Date.now());
  const step = lastStep === null ? now : Math.max(now, lastStep + 1);
  if (step > now + 1) {
    await new Promise((resolve) => setTimeout(resolve, (step - 1) * STEP_MS - Date.now() + 50));
  }
  return { code: codeForStep(secret, step), step };
}
