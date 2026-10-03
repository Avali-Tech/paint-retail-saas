import { describe, expect, it } from 'vitest';
import {
  FILTERED,
  redactText,
  scrubBreadcrumb,
  scrubEvent,
  scrubValue,
  stripQuery,
} from './error-scrubbing.js';

describe('redactText', () => {
  it.each([
    [
      'connect postgres://paint:s3cret@db.internal:5432/paint failed',
      `connect postgres://${FILTERED}@db.internal:5432/paint failed`,
    ],
    ['Authorization: Bearer abc.def-123', `Authorization: Bearer ${FILTERED}`],
    ['basic dXNlcjpwYXNz', `basic ${FILTERED}`],
    ['password=hunter2&next=1', `password=${FILTERED}&next=1`],
    ['{"otp": "482913"}', `{"otp": "${FILTERED}"}`],
    ['token:abc123', `token:${FILTERED}`],
    ['totp=12345678', `totp=${FILTERED}`],
    ['recovery code: k3m9-x2p7', `recovery code: ${FILTERED}`],
    ['recovery_codes="a1b2c3d4e5"', `recovery_codes="${FILTERED}"`],
    ['no account for asha@example.co.in', 'no account for [email]'],
    ['duplicate mobile 9876543210', 'duplicate mobile [phone]'],
    ['call +91 98765 43210 now', 'call [phone] now'],
    ['call +91-9876543210', 'call [phone]'],
    ['your code is 482913.', 'your code is [code].'],
  ])('masks %s', (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it('leaves ordinary text, longer numbers and amounts alone', () => {
    const text = 'Stock count SC-000123 failed after 1234567 ms for 12345 paise';
    expect(redactText(text)).toBe(text);
  });
});

describe('stripQuery', () => {
  it('drops query strings and fragments', () => {
    expect(stripQuery('https://app.example/api/parties?q=asha#top')).toBe(
      'https://app.example/api/parties',
    );
    expect(stripQuery('/stores')).toBe('/stores');
  });
});

describe('scrubValue', () => {
  it('filters sensitive keys at any depth and redacts strings', () => {
    expect(
      scrubValue({
        password: 'x',
        nested: { authorization: 'Bearer t', list: [{ phone: '9876543210', note: 'otp 123456' }] },
        count: 3,
        empty: null,
        code: '123456',
        postcode: 'kept',
      }),
    ).toEqual({
      password: FILTERED,
      nested: { authorization: FILTERED, list: [{ phone: FILTERED, note: 'otp [code]' }] },
      count: 3,
      empty: null,
      code: FILTERED,
      postcode: 'kept',
    });
  });

  it('filters 2FA secrets, OTP/TOTP and recovery codes, auth headers and bodies', () => {
    const scrubbed = scrubValue({
      totpCode: '123456',
      totpSecret: 'JBSWY3DPEHPK3PXP',
      recoveryCodes: ['k3m9-x2p7', 'q8w2-z5n1'],
      backup_code: 'k3m9-x2p7',
      verificationCode: '1234',
      mfa: { enabled: true },
      twoFactorEnabled: true,
      'x-api-key': 'k',
      Authorization: 'Basic dXNlcjpwYXNz',
      'proxy-authorization': 'x',
      body: { name: 'Asha' },
      payload: 'raw',
      data: { anything: 1 },
      statusCode: 500,
      method: 'POST',
    });

    expect(scrubbed).toEqual({
      totpCode: FILTERED,
      totpSecret: FILTERED,
      recoveryCodes: FILTERED,
      backup_code: FILTERED,
      verificationCode: FILTERED,
      mfa: FILTERED,
      twoFactorEnabled: FILTERED,
      'x-api-key': FILTERED,
      Authorization: FILTERED,
      'proxy-authorization': FILTERED,
      body: FILTERED,
      payload: FILTERED,
      data: FILTERED,
      statusCode: 500,
      method: 'POST',
    });
  });

  it('stops at a fixed depth', () => {
    let deep: unknown = 'bottom';
    for (let level = 0; level < 10; level += 1) deep = { level: deep };
    expect(JSON.stringify(scrubValue(deep))).toContain(FILTERED);
    expect(JSON.stringify(scrubValue(deep))).not.toContain('bottom');
  });
});

describe('scrubBreadcrumb', () => {
  it('redacts the message, filters data and strips query strings from URLs', () => {
    expect(
      scrubBreadcrumb({
        category: 'fetch',
        message: 'sent 482913',
        data: { url: '/api/auth/otp/verify?code=1', method: 'POST', token: 'x' },
      }),
    ).toEqual({
      category: 'fetch',
      message: 'sent [code]',
      data: { url: '/api/auth/otp/verify', method: 'POST', token: FILTERED },
    });
  });

  it('passes through breadcrumbs without a message or data', () => {
    expect(scrubBreadcrumb({ category: 'navigation' })).toEqual({ category: 'navigation' });
    expect(scrubBreadcrumb({ data: { status: 500 } })).toEqual({ data: { status: 500 } });
  });
});

describe('scrubEvent', () => {
  it('keeps only the method and path of the request, and only the user id', () => {
    const event = scrubEvent({
      event_id: 'abc',
      request: {
        method: 'POST',
        url: 'https://api.example/auth/login?next=/x',
        data: { password: 'hunter2' },
        headers: { authorization: 'Bearer t', cookie: 'sid=1' },
        cookies: { sid: '1' },
        query_string: 'next=/x',
      },
      user: { id: 'u1', email: 'a@b.co', ip_address: '1.2.3.4' },
    });

    expect(event).toEqual({
      event_id: 'abc',
      request: { method: 'POST', url: 'https://api.example/auth/login' },
      user: { id: 'u1' },
    });
  });

  it('masks personal data that appears in the request path', () => {
    expect(scrubEvent({ request: { url: '/parties/by-mobile/9876543210?x=1' } }).request).toEqual({
      url: '/parties/by-mobile/[phone]',
    });
  });

  it('drops a user without an id and keeps empty requests empty', () => {
    expect(scrubEvent({ user: { email: 'a@b.co' } as { id?: string }, request: {} })).toEqual({
      request: {},
    });
  });

  it('redacts messages, exception values, extras and contexts; filters tag keys', () => {
    const event = scrubEvent({
      message: 'login failed for 9876543210',
      logentry: { message: 'code %s for asha@example.com', params: ['123456'] },
      exception: { values: [{ type: 'Error', value: 'bad otp 123456' }, { type: 'Error' }] },
      extra: { body: { password: 'x' }, note: 'ok' },
      contexts: { app: { session: 's', version: '1' }, empty: undefined },
      tags: { request_id: 'a1234567-0000-4000-8000-123456789012', session_token: 't' },
      breadcrumbs: [{ message: 'otp 654321' }],
    });

    expect(event).toEqual({
      message: 'login failed for [phone]',
      logentry: { message: 'code %s for [email]' },
      exception: { values: [{ type: 'Error', value: 'bad otp [code]' }, { type: 'Error' }] },
      extra: { body: FILTERED, note: 'ok' },
      contexts: { app: { session: FILTERED, version: '1' }, empty: undefined },
      tags: { request_id: 'a1234567-0000-4000-8000-123456789012', session_token: FILTERED },
      breadcrumbs: [{ message: 'otp [code]' }],
    });
  });

  it('handles a log entry without a message and an exception without values', () => {
    expect(scrubEvent({ logentry: { params: ['x'] }, exception: {} })).toEqual({
      logentry: {},
      exception: {},
    });
  });
});
