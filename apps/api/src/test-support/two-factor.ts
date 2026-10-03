import { base32Decode, totp } from '../auth/totp.js';
import type { TestApp } from './test-app.js';

type Reply = Awaited<ReturnType<TestApp['app']['inject']>>;

interface Pending {
  twoFactor: { pendingToken: string; setupRequired: boolean };
}

/** Recovery codes of people the tests signed in with two factors, by sign-in identifier. */
const recoveryCodes = new Map<string, string[]>();

/** An authenticator app's current code for a base32 secret. */
export const appCode = (secret: string, at = Date.now()) => totp(base32Decode(secret), at);

/**
 * Takes a sign-in response through its second step if it has one, the way a
 * person would: the first time, adds an authenticator app and keeps its
 * recovery codes; later, spends one recovery code each time (so no TOTP code
 * is ever reused). Returns the final response; anything else passes through.
 */
export async function completeSignIn(
  t: TestApp,
  first: Reply,
  identifier: string,
  { platform = false } = {},
): Promise<Reply> {
  const body = first.statusCode === 200 ? (JSON.parse(first.body) as object) : {};
  if (!('twoFactor' in body)) return first;
  const { pendingToken, setupRequired } = (body as Pending).twoFactor;
  const base = platform ? '/platform/login/2fa' : '/auth/2fa';
  let code: string;
  if (setupRequired) {
    const setup = await t.app.inject({
      method: 'POST',
      url: `${base}/setup`,
      payload: { pendingToken },
    });
    code = appCode(setup.json<{ secret: string }>().secret);
  } else {
    const codes = recoveryCodes.get(identifier);
    if (!codes?.length) throw new Error(`No recovery codes kept for ${identifier}`);
    code = String(codes.pop());
  }
  const verified = await t.app.inject({
    method: 'POST',
    url: platform ? base : `${base}/verify`,
    payload: { pendingToken, code },
  });
  const result = verified.json<{ recoveryCodes?: string[] }>();
  if (result.recoveryCodes) recoveryCodes.set(identifier, [...result.recoveryCodes]);
  return verified;
}

/** Like completeSignIn, but requires success and returns the body. */
export async function finishSignIn<T extends object>(
  t: TestApp,
  first: Reply,
  identifier: string,
  options: { platform?: boolean } = {},
): Promise<T> {
  const reply = await completeSignIn(t, first, identifier, options);
  if (reply.statusCode !== 200) throw new Error(`Sign-in failed: ${reply.body}`);
  return reply.json<T>();
}
