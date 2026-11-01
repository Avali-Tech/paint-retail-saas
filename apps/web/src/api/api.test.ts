import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '../i18n/en.js';
import { hi } from '../i18n/hi.js';
import { fakeFetch, json } from '../test-support/fake-api.js';
import { buildUrl, createApiClient, parseJson } from './client.js';
import { endpoints } from './endpoints.js';
import { ApiError, errorMessage, errorWithIssues, setErrorTexts, toApiError } from './errors.js';

function client(routes: Parameters<typeof fakeFetch>[0], token: string | null = 'tok') {
  const api = fakeFetch(routes);
  const onUnauthorized = vi.fn();
  return {
    ...api,
    onUnauthorized,
    api: createApiClient({
      baseUrl: '/api/',
      fetch: api.fetch,
      getToken: () => token,
      onUnauthorized,
    }),
  };
}

describe('buildUrl', () => {
  it('joins the base, path and query, skipping undefined values', () => {
    expect(buildUrl('/api/', '/search', { q: 'apex 1l', limit: 5, store: undefined })).toBe(
      '/api/search?q=apex+1l&limit=5',
    );
    expect(buildUrl('https://api.example.com', '/auth/me')).toBe('https://api.example.com/auth/me');
  });
});

describe('parseJson', () => {
  it('reads JSON and tolerates empty or non-JSON bodies', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson('')).toBeNull();
    expect(parseJson('<html>Bad gateway</html>')).toBeNull();
  });
});

describe('createApiClient', () => {
  it('sends the bearer token and JSON, and returns the parsed answer', async () => {
    const { api, requests } = client({ 'POST /things': () => json({ id: 'x' }, 201) });
    await expect(api.post('/things', { name: 'Apex' })).resolves.toEqual({ id: 'x' });
    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/things',
      body: { name: 'Apex' },
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: 'Bearer tok',
      },
    });
  });

  it('posts a JSON body for a file that is made on request, such as an export', async () => {
    const { api, requests } = client({
      'POST /exports': () => ({
        status: 200,
        raw: 'PK',
        headers: { 'content-disposition': 'attachment; filename="tally.zip"' },
      }),
    });
    const file = await api.download('/exports', { body: { format: 'xlsx' } });
    expect(file.fileName).toBe('tally.zip');
    expect(await file.blob.text()).toBe('PK');
    expect(requests[0]).toMatchObject({
      method: 'POST',
      body: { format: 'xlsx' },
      headers: { accept: '*/*', 'content-type': 'application/json' },
    });
  });

  it('sends extra headers such as an idempotency key', async () => {
    const { api, requests } = client({ 'POST /things': () => json({ id: 'x' }, 201) });
    await api.post('/things', { name: 'Apex' }, { headers: { 'Idempotency-Key': 'bill-1' } });
    expect(requests[0]?.headers).toMatchObject({
      'Idempotency-Key': 'bill-1',
      accept: 'application/json',
    });
  });

  it('sends an empty JSON object for a POST without a body, and nothing for a GET', async () => {
    const { api, requests } = client({
      'POST /auth/logout': () => ({ status: 204 }),
      'GET /auth/me': () => json({ ok: true }),
    });
    await expect(api.post('/auth/logout')).resolves.toBeNull();
    expect(requests[0]?.body).toEqual({});
    await api.get('/auth/me');
    expect(requests[1]?.body).toBeUndefined();
    expect(requests[1]?.headers).not.toHaveProperty('content-type');
  });

  it('leaves out the token when signed out', async () => {
    const { api, requests } = client({ 'PUT /x': () => json({}) }, null);
    await api.put('/x', { a: 1 });
    expect(requests[0]?.headers).not.toHaveProperty('authorization');
  });

  it('maps error answers to ApiError with field issues', async () => {
    const { api } = client({
      'POST /auth/login': () =>
        json(
          {
            statusCode: 400,
            message: 'Invalid request',
            issues: [{ path: 'identifier', message: 'Too short' }],
          },
          400,
        ),
    });
    const error = await api.post('/auth/login', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      message: 'Invalid request',
      issues: [{ path: 'identifier', message: 'Too short' }],
    });
  });

  it('ends the session on 401 only when one was sent', async () => {
    const signedIn = client({ 'GET /auth/me': () => json({ message: 'Unauthorized' }, 401) });
    await expect(signedIn.api.get('/auth/me')).rejects.toMatchObject({ status: 401 });
    expect(signedIn.onUnauthorized).toHaveBeenCalledOnce();

    const signedOut = client(
      { 'POST /auth/login': () => json({ message: 'Invalid sign-in details' }, 401) },
      null,
    );
    await expect(signedOut.api.post('/auth/login', {})).rejects.toThrow('Invalid sign-in details');
    expect(signedOut.onUnauthorized).not.toHaveBeenCalled();
  });

  it('reports an unreachable server as status 0', async () => {
    const api = createApiClient({
      baseUrl: '/api',
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      getToken: () => null,
      onUnauthorized: vi.fn(),
    });
    await expect(api.get('/health')).rejects.toMatchObject({
      status: 0,
      message: 'Cannot reach the server. Check your internet connection and try again.',
    });
  });

  it('lets cancelled requests stay cancelled', async () => {
    const { api } = client({ 'GET /search': () => json({}) });
    const controller = new AbortController();
    controller.abort();
    await expect(api.get('/search', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('toApiError', () => {
  it('uses the server message, joining lists', () => {
    expect(toApiError(400, { message: ['a', 'b'] }).message).toBe('a. b');
    expect(toApiError(409, { message: 'Taken' }).message).toBe('Taken');
  });

  it('falls back to a message for the status, or a general one', () => {
    expect(toApiError(403, null).message).toBe('You do not have permission to do this.');
    expect(toApiError(429, { message: '' }).message).toContain('Too many attempts');
    expect(toApiError(404, { message: [] }).message).toBe('Not found.');
    expect(toApiError(401, 'oops').message).toBe('Please sign in again.');
    expect(toApiError(502, {}).message).toBe('Something went wrong. Please try again.');
  });

  it('keeps well-formed issues and business choices, dropping the rest', () => {
    const error = toApiError(409, {
      message: 'Choose which business to sign in to',
      issues: [{ path: 'a', message: 'b' }, { path: 1 }, 'junk'],
      organizations: [{ id: 'o1', name: 'ABC Paints' }, { id: 2, name: 'x' }, null],
    });
    expect(error.issues).toEqual([{ path: 'a', message: 'b' }]);
    expect(error.organizations).toEqual([{ id: 'o1', name: 'ABC Paints' }]);
    expect(toApiError(400, { issues: 'none' }).issues).toEqual([]);
  });
});

describe('errorMessage', () => {
  afterEach(() => {
    setErrorTexts(en.errors);
  });

  it('shows API messages and hides anything else', () => {
    expect(errorMessage(new ApiError(500, 'Database down'))).toBe('Database down');
    expect(errorMessage(new Error('stack trace'))).toBe('Something went wrong. Please try again.');
  });

  it('explains problems without a server message in the current language', () => {
    const offline = toApiError(0, null);
    expect(offline.fallback).toBe('offline');
    expect(toApiError(409, { message: 'Taken' }).fallback).toBeNull();
    setErrorTexts(hi.errors);
    expect(errorMessage(offline)).toBe(hi.errors.offline);
    expect(errorMessage(new Error('x'))).toBe(hi.errors.generic);
    expect(errorMessage(new ApiError(500, 'Database down'))).toBe('Database down');
    expect(toApiError(403, null).message).toBe(hi.errors.forbidden);
  });

  it('adds what the API said about each field when asked', () => {
    const refused = new ApiError(422, 'Cannot record the payment', [
      { path: 'reference', message: 'Enter the cheque number' },
      { path: 'chequeDate', message: 'And its date' },
    ]);
    expect(errorWithIssues(refused)).toBe(
      'Cannot record the payment: Enter the cheque number. And its date',
    );
    expect(errorWithIssues(new ApiError(409, 'Closed'))).toBe('Closed');
    expect(errorWithIssues(new Error('x'))).toBe('Something went wrong. Please try again.');
  });
});

describe('endpoints', () => {
  it('calls each route the app uses', async () => {
    const ok = () => json({ ok: true });
    const { api, requests } = client({
      'POST /auth/login': ok,
      'POST /auth/otp/request': ok,
      'POST /auth/otp/verify': ok,
      'GET /auth/me': ok,
      'POST /auth/logout': ok,
      'GET /dashboard': ok,
      'GET /search': ok,
      'GET /search/actions': ok,
      'GET /notifications': ok,
      'POST /notifications/n1/read': ok,
      'POST /notifications/read-all': ok,
      'POST /auth/2fa/setup': ok,
      'POST /auth/2fa/verify': ok,
      'GET /auth/2fa': ok,
      'POST /auth/2fa/enrol': ok,
      'POST /auth/2fa/confirm': ok,
      'POST /auth/2fa/recovery-codes': ok,
      'POST /auth/2fa/disable': ok,
      'GET /organization/security': ok,
      'PUT /organization/security': ok,
      'GET /members': ok,
      'GET /members/m1': ok,
      'POST /members': ok,
      'PATCH /members/m1': ok,
      'POST /members/m1/two-factor/reset': ok,
      'GET /roles': ok,
      'POST /roles': ok,
      'PATCH /roles/r1': ok,
    });
    const calls = endpoints(api);
    await calls.auth.login({ identifier: 'a@b.in', password: 'pw' });
    await calls.auth.requestOtp('9876543210');
    await calls.auth.verifyOtp({ phone: '9876543210', code: '123456', organizationId: 'o1' });
    await calls.auth.me();
    await calls.auth.logout();
    await calls.dashboard('store-1');
    await calls.dashboard();
    await calls.search('apex');
    await calls.quickActions();
    await calls.quickActions('new');
    await calls.notifications.list();
    await calls.notifications.list(30);
    await calls.notifications.markRead('n1');
    await calls.notifications.markAllRead();
    await calls.twoFactor.setUp('pending');
    await calls.twoFactor.verify('pending', '123456');
    await calls.twoFactor.status();
    await calls.twoFactor.enrol();
    await calls.twoFactor.confirm('123456');
    await calls.twoFactor.renewRecoveryCodes('k7pq-2mxa');
    await calls.twoFactor.disable('654321');
    await calls.organization.security();
    await calls.organization.setSecurity({ twoFactorRequired: false });
    await calls.team.members();
    await calls.team.member('m1');
    await calls.team.addMember({
      fullName: 'Ravi',
      phone: '9876543210',
      roleId: 'r1',
      allStores: false,
      storeIds: ['s1'],
    });
    await calls.team.updateMember('m1', { isActive: false });
    await calls.team.resetTwoFactor('m1');
    await calls.team.roles();
    await calls.team.createRole({ name: 'Cashier', permissions: ['stores:read'] });
    await calls.team.updateRole('r1', { name: 'Senior cashier' });
    expect(
      requests.map((request) => `${request.method} ${request.path}?${request.query.toString()}`),
    ).toEqual([
      'POST /auth/login?',
      'POST /auth/otp/request?',
      'POST /auth/otp/verify?',
      'GET /auth/me?',
      'POST /auth/logout?',
      'GET /dashboard?storeId=store-1',
      'GET /dashboard?',
      'GET /search?q=apex',
      'GET /search/actions?q=',
      'GET /search/actions?q=new',
      'GET /notifications?limit=10',
      'GET /notifications?limit=30',
      'POST /notifications/n1/read?',
      'POST /notifications/read-all?',
      'POST /auth/2fa/setup?',
      'POST /auth/2fa/verify?',
      'GET /auth/2fa?',
      'POST /auth/2fa/enrol?',
      'POST /auth/2fa/confirm?',
      'POST /auth/2fa/recovery-codes?',
      'POST /auth/2fa/disable?',
      'GET /organization/security?',
      'PUT /organization/security?',
      'GET /members?',
      'GET /members/m1?',
      'POST /members?',
      'PATCH /members/m1?',
      'POST /members/m1/two-factor/reset?',
      'GET /roles?',
      'POST /roles?',
      'PATCH /roles/r1?',
    ]);
    expect(requests.slice(14).map((request) => request.body)).toEqual([
      { pendingToken: 'pending' },
      { pendingToken: 'pending', code: '123456' },
      undefined,
      {},
      { code: '123456' },
      { code: 'k7pq-2mxa' },
      { code: '654321' },
      undefined,
      { twoFactorRequired: false },
      undefined,
      undefined,
      { fullName: 'Ravi', phone: '9876543210', roleId: 'r1', allStores: false, storeIds: ['s1'] },
      { isActive: false },
      {},
      undefined,
      { name: 'Cashier', permissions: ['stores:read'] },
      { name: 'Senior cashier' },
    ]);
    expect(requests[1]?.body).toEqual({ phone: '9876543210' });
    expect(requests[2]?.body).toEqual({
      phone: '9876543210',
      code: '123456',
      organizationId: 'o1',
    });
  });
});
