import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DASHBOARD, GRANT, OWNER, json } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { returnPath } from './SignInPage.js';
import { SESSION_KEY } from './session-store.js';

const signedInRoutes = {
  'GET /auth/me': () => json(OWNER),
  'GET /dashboard': () => json(DASHBOARD),
};

const TWO_BUSINESSES = {
  statusCode: 409,
  message: 'Choose which business to sign in to',
  organizations: [
    { id: 'org-a', name: 'ABC Paints' },
    { id: 'org-b', name: 'XYZ Colours' },
  ],
};

const location = () => screen.getByTestId('location').textContent;

describe('returnPath', () => {
  it('returns to the page that asked, never to another site', () => {
    expect(returnPath({ from: '/dashboard?store=1' })).toBe('/dashboard?store=1');
    expect(returnPath({ from: '//evil.example' })).toBe('/');
    expect(returnPath({ from: 'https://evil.example' })).toBe('/');
    expect(returnPath({ from: 7 })).toBe('/');
    expect(returnPath(null)).toBe('/');
    expect(returnPath('x')).toBe('/');
  });
});

describe('password sign-in', () => {
  it('signs in and opens the page that sent the visitor here', async () => {
    const { user, requests } = renderApp({
      path: '/dashboard',
      session: null,
      routes: { ...signedInRoutes, 'POST /auth/login': () => json(GRANT) },
    });
    expect(
      await screen.findByRole('heading', { name: 'Sign in to Paint Retail' }),
    ).toBeInTheDocument();
    expect(location()).toBe('/sign-in');
    await user.type(
      screen.getByRole('textbox', { name: 'Mobile number or email' }),
      ' 9876543210 ',
    );
    await user.type(screen.getByLabelText('Password', { selector: 'input' }), 'Staff@2026');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(location()).toBe('/dashboard');
    expect(requests.find((request) => request.path === '/auth/login')?.body).toEqual({
      identifier: '9876543210',
      password: 'Staff@2026',
    });
    expect(JSON.parse(String(localStorage.getItem(SESSION_KEY)))).toEqual(GRANT);
  });

  it('checks the form before sending it', async () => {
    const { user, requests } = renderApp({ path: '/sign-in', session: null });
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(
      screen.getByRole('textbox', { name: 'Mobile number or email' }),
    ).toHaveAccessibleDescription('The number or email you signed up with This is required');
    expect(screen.getByLabelText('Password', { selector: 'input' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(requests.filter((request) => request.path === '/auth/login')).toEqual([]);
  });

  it('shows the server’s answer: wrong details, or field problems', async () => {
    let answer = json({ statusCode: 401, message: 'Invalid sign-in details' }, 401);
    const { user } = renderApp({
      path: '/sign-in',
      session: null,
      routes: { 'POST /auth/login': () => answer },
    });
    await user.type(
      await screen.findByRole('textbox', { name: 'Mobile number or email' }),
      'anil@abc.in',
    );
    await user.type(screen.getByLabelText('Password', { selector: 'input' }), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid sign-in details');

    answer = json(
      {
        statusCode: 400,
        message: 'Invalid request',
        issues: [{ path: 'password', message: 'Too long' }],
      },
      400,
    );
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Too long')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();

    answer = json(
      {
        statusCode: 400,
        message: 'Invalid request',
        issues: [{ path: 'organizationId', message: 'Bad id' }],
      },
      400,
    );
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid request');
  });

  it('asks which business when the person belongs to several', async () => {
    const { user, requests } = renderApp({
      path: '/sign-in',
      session: null,
      routes: {
        ...signedInRoutes,
        'POST /auth/login': (request) =>
          (request.body as { organizationId?: string }).organizationId
            ? json({ ...GRANT, organizationId: 'org-b' })
            : json(TWO_BUSINESSES, 409),
      },
    });
    await user.type(
      await screen.findByRole('textbox', { name: 'Mobile number or email' }),
      'anil@abc.in',
    );
    await user.type(screen.getByLabelText('Password', { selector: 'input' }), 'Staff@2026');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose a business' });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'XYZ Colours' }),
    );
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(requests.filter((request) => request.path === '/auth/login').at(-1)?.body).toEqual({
      identifier: 'anil@abc.in',
      password: 'Staff@2026',
      organizationId: 'org-b',
    });
  });

  it('goes straight in when already signed in', async () => {
    renderApp({ path: '/sign-in', routes: signedInRoutes });
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
  });

  it('explains why the visitor is back at sign-in', async () => {
    const { services } = renderApp({ path: '/sign-in', session: null });
    await screen.findByRole('heading', { name: 'Sign in to Paint Retail' });
    expect(screen.queryByText('Your session has ended. Please sign in again.')).toBeNull();
    services.sessions.end('expired');
    expect(
      await screen.findByText('Your session has ended. Please sign in again.'),
    ).toBeInTheDocument();
    services.sessions.end('signed-out');
    expect(await screen.findByText('You have signed out.')).toBeInTheDocument();
  });
});

describe('mobile code sign-in', () => {
  const openOtp = async (user: ReturnType<typeof renderApp>['user']) => {
    await user.click(await screen.findByRole('tab', { name: 'Mobile code' }));
  };

  it('texts a code and signs in with it', async () => {
    const { user, requests } = renderApp({
      path: '/sign-in',
      session: null,
      routes: {
        ...signedInRoutes,
        'POST /auth/otp/request': () =>
          json({ message: 'If this number has an account, a code is on its way.' }, 202),
        'POST /auth/otp/verify': () => json(GRANT),
      },
    });
    await openOtp(user);
    await user.type(screen.getByRole('textbox', { name: 'Mobile number' }), '98765 43210');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText('Enter the code sent to 98765 43210')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: '6-digit code' }), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(requests.find((request) => request.path === '/auth/otp/verify')?.body).toEqual({
      phone: '98765 43210',
      code: '123456',
    });
  });

  it('checks the number and the code before sending', async () => {
    const { user, requests } = renderApp({
      path: '/sign-in',
      session: null,
      routes: { 'POST /auth/otp/request': () => json({ message: 'ok' }, 202) },
    });
    await openOtp(user);
    await user.type(screen.getByRole('textbox', { name: 'Mobile number' }), '12345');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText('Enter a 10-digit mobile number')).toBeInTheDocument();
    await user.clear(screen.getByRole('textbox', { name: 'Mobile number' }));
    await user.type(screen.getByRole('textbox', { name: 'Mobile number' }), '+91 98765 43210');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByRole('textbox', { name: '6-digit code' }), '12a');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText('Enter the 6-digit code')).toBeInTheDocument();
    expect(requests.filter((request) => request.path === '/auth/otp/verify')).toEqual([]);
  });

  it('shows why a code could not be sent or was refused', async () => {
    let requestAnswer = json(
      { statusCode: 503, message: 'Sign-in by SMS code is not available yet. Use your password.' },
      503,
    );
    const { user } = renderApp({
      path: '/sign-in',
      session: null,
      routes: {
        'POST /auth/otp/request': () => requestAnswer,
        'POST /auth/otp/verify': () =>
          json({ statusCode: 401, message: 'Invalid sign-in details' }, 401),
      },
    });
    await openOtp(user);
    await user.type(screen.getByRole('textbox', { name: 'Mobile number' }), '9876543210');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not available yet');

    requestAnswer = json(
      {
        statusCode: 400,
        message: 'Invalid request',
        issues: [{ path: 'phone', message: 'Enter a valid mobile number' }],
      },
      400,
    );
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText('Enter a valid mobile number')).toBeInTheDocument();

    requestAnswer = json({ message: 'ok' }, 202);
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByRole('textbox', { name: '6-digit code' }), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid sign-in details');
    expect(screen.getByRole('textbox', { name: '6-digit code' })).toHaveValue('');

    requestAnswer = json(
      { statusCode: 429, message: 'Please wait before requesting another code' },
      429,
    );
    await user.click(screen.getByRole('button', { name: 'Send a new code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please wait before requesting another code',
    );

    await user.click(screen.getByRole('button', { name: 'Use another number' }));
    expect(screen.getByRole('textbox', { name: 'Mobile number' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks which business, then sends the same code again with the choice', async () => {
    const { user, requests } = renderApp({
      path: '/sign-in',
      session: null,
      routes: {
        ...signedInRoutes,
        'POST /auth/otp/request': () => json({ message: 'ok' }, 202),
        'POST /auth/otp/verify': (request) =>
          (request.body as { organizationId?: string }).organizationId
            ? json({ ...GRANT, organizationId: 'org-a' })
            : json(TWO_BUSINESSES, 409),
      },
    });
    await openOtp(user);
    await user.type(screen.getByRole('textbox', { name: 'Mobile number' }), '9876543210');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByRole('textbox', { name: '6-digit code' }), '111111');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await screen.findByRole('dialog', { name: 'Choose a business' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'ABC Paints' }),
    );
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(
      requests
        .filter((request) => request.path.startsWith('/auth/otp/'))
        .map((request) => request.body),
    ).toEqual([
      { phone: '9876543210' },
      { phone: '9876543210', code: '111111' },
      { phone: '9876543210', code: '111111' },
      { phone: '9876543210', code: '111111', organizationId: 'org-a' },
    ]);
  });
});
