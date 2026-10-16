import { createHmac, timingSafeEqual } from 'node:crypto';

/** Hex HMAC-SHA256 of `body`, as Razorpay (and most Indian gateways) sign webhooks. */
export function hmacHex(secret: string, body: Buffer | string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** True when `signature` is the hex HMAC of `body`; compared in constant time. */
export function signatureMatches(secret: string, body: Buffer, signature: unknown): boolean {
  if (typeof signature !== 'string') return false;
  const expected = Buffer.from(hmacHex(secret, body), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
