import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingSignIn } from '../api/types.js';
import { DASHBOARD, GRANT, OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { groupKey } from './AuthenticatorSetup.js';
import { qrPath } from './QrCode.js';
import { SESSION_KEY } from './session-store.js';
import { isWrongCode } from './TwoFactorStep.js';
import { ApiError } from '../api/errors.js';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/Paint%20Retail%3A%2B919876543210?secret=${SECRET}&issuer=Paint+Retail`;
const CODES = Array.from({ length: 10 }, (_, index) => `k7pq-2mx${String(index)}`);

const pending = (overrides: Partial<PendingSignIn> = {}): PendingSignIn => ({
  pendingToken: 'pending-token-of-at-least-twenty-chars',
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  setupRequired: false,
  ...overrides,
});

const WRONG = () => json({ statusCode: 401, message: 'Wrong code' }, 401);
const EXPIRED = () => json({ statusCode: 401, message: 'Invalid or expired sign-in' }, 401);

const location = () => screen.getByTestId('location').textContent;

/** Signs in with a password, which the fake API answers with a two-factor step. */
async function reachSecondStep(
  routes: Record<string, FakeHandler>,
  step: PendingSignIn = pending(),
) {
  const view = renderApp({
    path: '/sign-in',
    session: null,
    routes: {
      'GET /auth/me': () => json(OWNER),
      'GET /dashboard': () => json(DASHBOARD),
      'POST /auth/login': () => json({ twoFactor: step }),
      ...routes,
    },
  });
  await view.user.type(
    await screen.findByRole('textbox', { name: 'Mobile number or email' }),
    'anil@abc.in',
  );
  await view.user.type(screen.getByLabelText('Password', { selector: 'input' }), 'Staff@2026');
  await view.user.click(screen.getByRole('button', { name: 'Sign in' }));
  return view;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('helpers', () => {
  it('draws a QR code with a quiet zone, and groups the setup key in fours', () => {
    const { size, path } = qrPath(URI);
    // Version 6 (41 modules) for a URI this long, plus 4 modules of quiet zone each side.
    expect(size).toBeGreaterThanOrEqual(41 + 8);
    expect(path).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
    expect(path).not.toContain('M0 0');
    expect(groupKey('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
    expect(groupKey('ABCDEFGH')).toBe('ABCD EFGH');
  });

  it('tells a wrong code from an expired sign-in', () => {
    expect(isWrongCode(new ApiError(401, 'Wrong code'))).toBe(true);
    expect(isWrongCode(new ApiError(401, 'Invalid or expired sign-in'))).toBe(false);
    expect(isWrongCode(new ApiError(400, 'Wrong code'))).toBe(false);
    expect(isWrongCode(new Error('Wrong code'))).toBe(false);
  });
});

describe('first-time setup during sign-in', () => {
  it('adds the app from a QR code, shows recovery codes once, then signs in', async () => {
    const { user, requests } = await reachSecondStep(
      {
        'POST /auth/2fa/setup': () => json({ secret: SECRET, otpauthUri: URI }),
        'POST /auth/2fa/verify': () => json({ ...GRANT, recoveryCodes: CODES }),
      },
      pending({ setupRequired: true }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Add an authenticator app' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Setup key' })).toHaveValue(groupKey(SECRET));
    expect(
      screen.getByRole('link', { name: 'On this phone? Open the authenticator app instead' }),
    ).toHaveAttribute('href', URI);
    // No recovery codes exist yet, so there is nothing to switch to.
    expect(screen.queryByRole('button', { name: 'Use a recovery code instead' })).toBeNull();
    await user.click(screen.getByRole('textbox', { name: 'Setup key' }));

    await user.type(screen.getByRole('textbox', { name: '6-digit code' }), '12');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText('Enter the 6-digit code')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: '6-digit code' }), '3456');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));

    const list = await screen.findByRole('list', { name: 'Recovery codes' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(CODES);
    // Not signed in until the codes are saved.
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    const done = screen.getByRole('button', { name: 'Continue' });
    expect(done).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Recovery codes copied')).toBeInTheDocument();
    const copied = await navigator.clipboard.readText();
    expect(copied).toBe(
      `Paint Retail recovery codes. Each code works once.\n\n${CODES.join('\n')}\n`,
    );

    const createObjectURL = vi.fn(() => 'blob:codes');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe('recovery-codes.txt');
      expect(this.href).toBe('blob:codes');
    });
    await user.click(screen.getByRole('button', { name: 'Download .txt' }));
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:codes');
    const [[blob]] = createObjectURL.mock.calls as unknown as [[Blob]];
    expect(await blob.text()).toBe(copied);

    await user.click(screen.getByRole('checkbox', { name: 'I have saved my recovery codes' }));
    await user.click(done);
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(JSON.parse(String(localStorage.getItem(SESSION_KEY)))).toEqual(GRANT);
    expect(
      requests
        .filter((request) => request.path.startsWith('/auth/2fa'))
        .map((request) => [request.path, request.body]),
    ).toEqual([
      ['/auth/2fa/setup', { pendingToken: pending().pendingToken }],
      ['/auth/2fa/verify', { pendingToken: pending().pendingToken, code: '123456' }],
    ]);
  });

  it('says when the codes could not be copied', async () => {
    const { user } = await reachSecondStep(
      {
        'POST /auth/2fa/setup': () => json({ secret: SECRET, otpauthUri: URI }),
        'POST /auth/2fa/verify': () => json({ ...GRANT, recoveryCodes: CODES }),
      },
      pending({ setupRequired: true }),
    );
    await user.type(await screen.findByRole('textbox', { name: '6-digit code' }), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await screen.findByRole('list', { name: 'Recovery codes' });
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(
      await screen.findByText('Could not copy. Select the codes and copy them yourself.'),
    ).toBeInTheDocument();
  });

  it('offers a retry when the app cannot be added, and starts over when the sign-in has expired', async () => {
    let answer = json({ statusCode: 503, message: 'Database down' }, 503);
    const { user } = await reachSecondStep(
      { 'POST /auth/2fa/setup': () => answer },
      pending({ setupRequired: true }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Database down');
    answer = EXPIRED();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText('This sign-in has expired. Please sign in again.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(screen.getByRole('tab', { name: 'Password', selected: true })).toBeInTheDocument();
  });
});

describe('the code step', () => {
  it('counts down the tries for wrong codes, then sends the person back to sign in', async () => {
    const { user, requests } = await reachSecondStep({ 'POST /auth/2fa/verify': WRONG });
    expect(await screen.findByRole('heading', { name: 'Confirm it’s you' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Open your authenticator app and enter the 6-digit code it shows for Paint Retail.',
      ),
    ).toBeInTheDocument();
    const box = screen.getByRole('textbox', { name: '6-digit code' });
    for (const message of [
      'Wrong code. 4 tries left.',
      'Wrong code. 3 tries left.',
      'Wrong code. 2 tries left.',
      'Wrong code. 1 try left.',
    ]) {
      await user.type(box, '000000');
      await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(box).toHaveValue('');
    }
    await user.type(box, '000000');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(
      await screen.findByText('This sign-in has expired. Please sign in again.'),
    ).toBeInTheDocument();
    expect(requests.filter((request) => request.path === '/auth/2fa/verify')).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(screen.getByRole('textbox', { name: 'Mobile number or email' })).toBeInTheDocument();
  });

  it('takes a recovery code instead', async () => {
    const { user, requests } = await reachSecondStep({
      'POST /auth/2fa/verify': () => json(GRANT),
    });
    await user.click(await screen.findByRole('button', { name: 'Use a recovery code instead' }));
    expect(
      screen.getByText('Enter one of the recovery codes you saved when you added the app.'),
    ).toBeInTheDocument();
    const box = screen.getByRole('textbox', { name: 'Recovery code' });
    expect(box).toHaveAccessibleDescription('Looks like k7pq-2mxa. Each code works once.');
    await user.type(box, 'k7pq');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText('Enter a recovery code')).toBeInTheDocument();

    // Back and forth: each kind of code gets its own empty box.
    await user.click(screen.getByRole('button', { name: 'Use a code from the app' }));
    expect(screen.getByRole('textbox', { name: '6-digit code' })).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    await user.type(screen.getByRole('textbox', { name: 'Recovery code' }), ' k7pq-2mxa ');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(requests.find((request) => request.path === '/auth/2fa/verify')?.body).toEqual({
      pendingToken: pending().pendingToken,
      code: 'k7pq-2mxa',
    });
  });

  it('shows other refusals as they come, and goes back on request', async () => {
    const { user } = await reachSecondStep({
      'POST /auth/2fa/verify': () =>
        json({ statusCode: 403, message: 'This business is suspended' }, 403),
    });
    await user.type(await screen.findByRole('textbox', { name: '6-digit code' }), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This business is suspended');
    await user.click(screen.getByRole('button', { name: 'Back to sign-in' }));
    expect(screen.getByRole('textbox', { name: 'Mobile number or email' })).toBeInTheDocument();
  });

  it('starts over when the server says the sign-in has expired', async () => {
    const { user } = await reachSecondStep({ 'POST /auth/2fa/verify': EXPIRED });
    await user.type(await screen.findByRole('textbox', { name: '6-digit code' }), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(
      await screen.findByText('This sign-in has expired. Please sign in again.'),
    ).toBeInTheDocument();
  });

  it('notices on its own when the 5 minutes are up', async () => {
    await reachSecondStep({}, pending({ expiresAt: new Date(Date.now() + 50).toISOString() }));
    expect(
      await screen.findByText('This sign-in has expired. Please sign in again.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '6-digit code' })).toBeNull();
  });

  it('follows a mobile code sign-in, after choosing the business', async () => {
    const { user, requests } = renderApp({
      path: '/sign-in',
      session: null,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /dashboard': () => json(DASHBOARD),
        'POST /auth/otp/request': () => json({ message: 'ok' }, 202),
        'POST /auth/otp/verify': (request) =>
          (request.body as { organizationId?: string }).organizationId
            ? json({ twoFactor: pending() })
            : json(
                {
                  statusCode: 409,
                  message: 'Choose which business to sign in to',
                  organizations: [
                    { id: 'org-a', name: 'ABC Paints' },
                    { id: 'org-b', name: 'XYZ Colours' },
                  ],
                },
                409,
              ),
        'POST /auth/2fa/verify': () => json(GRANT),
      },
    });
    await user.click(await screen.findByRole('tab', { name: 'Mobile code' }));
    await user.type(screen.getByRole('textbox', { name: 'Mobile number' }), '9876543210');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByRole('textbox', { name: '6-digit code' }), '111111');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'XYZ Colours' }),
    );
    expect(await screen.findByRole('heading', { name: 'Confirm it’s you' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to sign-in' }));
    // Back where the person started: the mobile code tab.
    expect(screen.getByRole('tab', { name: 'Mobile code', selected: true })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Mobile number' }), '9876543210');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByRole('textbox', { name: '6-digit code' }), '222222');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'XYZ Colours' }),
    );
    await user.type(await screen.findByRole('textbox', { name: '6-digit code' }), '333333');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await waitFor(() => {
      expect(location()).toBe('/dashboard');
    });
    expect(requests.filter((request) => request.path === '/auth/2fa/verify')).toHaveLength(1);
  });
});
