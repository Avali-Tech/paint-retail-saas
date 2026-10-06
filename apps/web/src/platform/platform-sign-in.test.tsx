import { DEFAULT_BRANDING } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SESSION_KEY } from '../auth/session-store.js';
import { GRANT, json, type FakeHandler } from '../test-support/fake-api.js';
import { OPERATOR_SESSION, signInOperator } from '../test-support/platform-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { BRANDING_KEY } from '../theme/branding-source.js';
import { PLATFORM_SESSION_KEY } from './platform-session-store.js';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const ENROLMENT = { secret: SECRET, otpauthUri: `otpauth://totp/Platform?secret=${SECRET}` };
const CODES = Array.from({ length: 10 }, (_, index) => `k7pq-2mx${String(index)}`);
const pending = (setupRequired: boolean) => ({
  twoFactor: {
    pendingToken: 'pending-token-of-at-least-twenty-chars',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    setupRequired,
  },
});
const EMPTY_TENANTS = () => json({ items: [], total: 0 });
const location = () => screen.getByTestId('location').textContent;

function renderConsole(path: string, routes: Record<string, FakeHandler>) {
  return renderApp({ path, session: null, routes });
}

async function submitPassword(user: ReturnType<typeof renderApp>['user']) {
  await user.type(
    await screen.findByRole('textbox', { name: 'Email or mobile number' }),
    ' ops@paint.in ',
  );
  await user.type(screen.getByLabelText('Password', { selector: 'input' }), 'Operator@2026');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('platform console sign-in', () => {
  it('sends operators to its own sign-in, then adds an authenticator app at the first sign-in', async () => {
    // Someone at a business is signed in on this device too; the console never uses that session.
    localStorage.setItem(SESSION_KEY, JSON.stringify(GRANT));
    const { user, requests } = renderConsole('/platform/support', {
      'POST /platform/login': (request) =>
        (request.body as { password: string }).password === 'Operator@2026'
          ? json(pending(true))
          : json({ statusCode: 401, message: 'Wrong email, mobile number or password' }, 401),
      'POST /platform/login/2fa/setup': () => json(ENROLMENT),
      'POST /platform/login/2fa': () => json({ ...OPERATOR_SESSION, recoveryCodes: CODES }),
      'GET /platform/support-grants': () => json([]),
    });
    expect(
      await screen.findByRole('heading', { name: 'Sign in to the platform console' }),
    ).toBeVisible();
    expect(screen.getByText('Platform console')).toBeInTheDocument();
    expect(location()).toBe('/platform/sign-in');

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findAllByText('This is required')).toHaveLength(2);

    await user.type(
      screen.getByRole('textbox', { name: 'Email or mobile number' }),
      'ops@paint.in',
    );
    await user.type(screen.getByLabelText('Password', { selector: 'input' }), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Wrong email, mobile number or password',
    );
    await user.clear(screen.getByLabelText('Password', { selector: 'input' }));
    await user.type(screen.getByLabelText('Password', { selector: 'input' }), 'Operator@2026');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Add an authenticator app' })).toBeVisible();
    expect(
      await screen.findByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: '6-digit code' }), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    const list = await screen.findByRole('list', { name: 'Recovery codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    await user.click(screen.getByRole('checkbox', { name: 'I have saved my recovery codes' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Back on the page that asked, signed in with the operator's own token.
    expect(await screen.findByRole('heading', { name: 'Support access', level: 1 })).toBeVisible();
    expect(location()).toBe('/platform/support');
    const login = requests.find((request) => request.path === '/platform/login');
    expect(login?.headers.authorization).toBeUndefined();
    expect(requests.find((request) => request.path === '/platform/login/2fa')?.body).toEqual({
      pendingToken: 'pending-token-of-at-least-twenty-chars',
      code: '123456',
    });
    expect(
      requests.find((request) => request.path === '/platform/support-grants')?.headers
        .authorization,
    ).toBe('Bearer operator-token');
    // The operator's session is kept apart; the recovery codes are never stored.
    expect(JSON.parse(String(localStorage.getItem(PLATFORM_SESSION_KEY)))).toEqual(
      OPERATOR_SESSION,
    );
    expect(JSON.parse(String(localStorage.getItem(SESSION_KEY)))).toEqual(GRANT);
  });

  it('asks for a code from the app on later sign-ins and opens the businesses list', async () => {
    const { user } = renderConsole('/platform/sign-in', {
      'POST /platform/login': () => json(pending(false)),
      'POST /platform/login/2fa': () => json(OPERATOR_SESSION),
      'GET /platform/tenants': EMPTY_TENANTS,
    });
    await submitPassword(user);
    expect(await screen.findByRole('heading', { name: 'Confirm it’s you' })).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: '6-digit code' }), '654321');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByRole('heading', { name: 'Businesses', level: 1 })).toBeVisible();
    expect(location()).toBe('/platform/tenants');
  });

  it('goes back to the password step on request', async () => {
    const { user } = renderConsole('/platform/sign-in', {
      'POST /platform/login': () => json(pending(false)),
    });
    await submitPassword(user);
    await user.click(await screen.findByRole('button', { name: 'Back to sign-in' }));
    expect(await screen.findByRole('textbox', { name: 'Email or mobile number' })).toBeVisible();
  });

  it('skips sign-in when already signed in', async () => {
    signInOperator();
    renderConsole('/platform/sign-in', { 'GET /platform/tenants': EMPTY_TENANTS });
    expect(await screen.findByRole('heading', { name: 'Businesses', level: 1 })).toBeVisible();
    expect(location()).toBe('/platform/tenants');
  });

  it('shows the product’s own look, not the branding of a business used on this device', async () => {
    localStorage.setItem(
      BRANDING_KEY,
      JSON.stringify({ ...DEFAULT_BRANDING, appName: 'Sharma Paints', primary: '#0f766e' }),
    );
    renderConsole('/platform/sign-in', {});
    await screen.findByRole('heading', { name: 'Sign in to the platform console' });
    await waitFor(() => {
      expect(document.title).toBe(DEFAULT_BRANDING.appName);
    });
  });

  it('says when the console session has ended, and comes back to the page afterwards', async () => {
    signInOperator();
    renderConsole('/platform/tenants?status=suspended', {
      'GET /platform/tenants': () => json({ statusCode: 401, message: 'Sign in' }, 401),
    });
    expect(
      await screen.findByText('Your console session has ended. Please sign in again.'),
    ).toBeVisible();
    expect(localStorage.getItem(PLATFORM_SESSION_KEY)).toBeNull();
  });

  it('signs out on the server and on this device, even when the server cannot be reached', async () => {
    for (const answer of [() => json(undefined, 204), () => json({ message: 'Down' }, 503)]) {
      signInOperator();
      const view = renderConsole('/platform', {
        'GET /platform/tenants': EMPTY_TENANTS,
        'POST /platform/logout': answer,
      });
      await view.user.click(await screen.findByRole('button', { name: 'Sign out' }));
      expect(await screen.findByText('You have signed out of the platform console.')).toBeVisible();
      expect(view.requests.some((request) => request.path === '/platform/logout')).toBe(true);
      expect(localStorage.getItem(PLATFORM_SESSION_KEY)).toBeNull();
      view.unmount();
    }
  });

  it('marks the console plainly and links its sections', async () => {
    signInOperator();
    const { user } = renderConsole('/platform/nowhere', {
      'GET /platform/tenants': EMPTY_TENANTS,
      'GET /platform/support-grants': () => json([]),
    });
    expect(await screen.findByRole('heading', { name: 'Businesses', level: 1 })).toBeVisible();
    const nav = screen.getByRole('navigation', { name: 'Platform console sections' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Businesses', 'Support access', 'Access log']);
    expect(screen.getByText('Platform console')).toBeInTheDocument();
    await user.click(within(nav).getByRole('link', { name: 'Access log' }));
    expect(await screen.findByRole('heading', { name: 'Access log', level: 1 })).toBeVisible();
  });
});
