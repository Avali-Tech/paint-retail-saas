import { PERMISSIONS } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TwoFactorStatus } from '../api/types.js';
import { CASHIER, OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';

const SECRET = 'JBSWY3DPEHPK3PXP';
const ENROLMENT = { secret: SECRET, otpauthUri: `otpauth://totp/Paint?secret=${SECRET}` };
const CODES = Array.from({ length: 10 }, (_, index) => `abcd-efg${String(index)}`);
const ADMIN = profile(
  PERMISSIONS.filter((permission) => permission !== 'audit:read'),
  { role: { key: 'org_admin', name: 'Organization Admin' } },
);

const status = (overrides: Partial<TwoFactorStatus> = {}): TwoFactorStatus => ({
  enabled: false,
  recoveryCodesLeft: 0,
  required: false,
  ...overrides,
});

function renderSecurity(me: unknown, routes: Record<string, FakeHandler>) {
  return renderApp({
    path: '/settings/security',
    routes: { 'GET /auth/me': () => json(me), ...routes },
  });
}

const card = (name: string) => screen.getByRole('region', { name });
const form = (name: string) => screen.getByRole('form', { name });

describe('own two-factor sign-in', () => {
  it('adds an authenticator app, confirms it and shows the recovery codes once', async () => {
    let current = status();
    let confirmAnswer = json({ statusCode: 400, message: 'Wrong code' }, 400);
    const { user, requests } = renderSecurity(CASHIER, {
      'GET /auth/2fa': () => json(current),
      'POST /auth/2fa/enrol': () => json(ENROLMENT),
      'POST /auth/2fa/confirm': () => confirmAnswer,
    });
    expect(
      await screen.findByRole('heading', { name: 'Account security', level: 1 }),
    ).toBeVisible();
    const account = card('Two-factor sign-in');
    expect(await within(account).findByText('Off')).toBeInTheDocument();
    expect(
      within(account).getByText(
        'Add an authenticator app so that a stolen password is not enough to sign in.',
      ),
    ).toBeInTheDocument();
    // Counter staff do not manage the business's rules or the team.
    expect(screen.queryByRole('region', { name: 'Business sign-in rules' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Team two-factor sign-in' })).toBeNull();

    await user.click(within(account).getByRole('button', { name: 'Add an authenticator app' }));
    expect(
      await within(account).findByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeInTheDocument();
    expect(within(account).getByRole('textbox', { name: 'Setup key' })).toHaveValue(
      'JBSW Y3DP EHPK 3PXP',
    );
    const confirm = form('Add an authenticator app');
    await user.type(within(confirm).getByRole('textbox', { name: '6-digit code' }), '12');
    await user.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    expect(
      await within(confirm).findByText('Enter a 6-digit code or a recovery code'),
    ).toBeInTheDocument();
    await user.type(within(confirm).getByRole('textbox', { name: '6-digit code' }), '3456');
    await user.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent('Wrong code');
    expect(within(confirm).getByRole('textbox', { name: '6-digit code' })).toHaveValue('');

    confirmAnswer = json({ recoveryCodes: CODES });
    current = status({ enabled: true, recoveryCodesLeft: 10 });
    await user.type(within(confirm).getByRole('textbox', { name: '6-digit code' }), '654321');
    await user.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Two-factor sign-in is on')).toBeInTheDocument();
    const list = await within(account).findByRole('list', { name: 'Recovery codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    await user.click(
      within(account).getByRole('checkbox', { name: 'I have saved my recovery codes' }),
    );
    await user.click(within(account).getByRole('button', { name: 'Continue' }));
    expect(await within(account).findByText('On')).toBeInTheDocument();
    expect(within(account).getByText('Recovery codes left: 10')).toBeInTheDocument();
    expect(requests.find((request) => request.path === '/auth/2fa/confirm')?.body).toEqual({
      code: '123456',
    });
  });

  it('shows why an app could not be added', async () => {
    const { user } = renderSecurity(CASHIER, {
      'GET /auth/2fa': () => json(status({ required: true })),
      'POST /auth/2fa/enrol': () =>
        json({ statusCode: 403, message: 'Support access cannot change two-factor sign-in' }, 403),
    });
    expect(
      await screen.findByText('Your business requires this for your role.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add an authenticator app' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Support access cannot change two-factor sign-in',
    );
  });

  it('renews recovery codes, and shows the refusal to turn off a required app', async () => {
    const { user, requests } = renderSecurity(CASHIER, {
      'GET /auth/2fa': () => json(status({ enabled: true, required: true, recoveryCodesLeft: 3 })),
      'POST /auth/2fa/recovery-codes': () => json({ recoveryCodes: CODES }),
      'POST /auth/2fa/disable': () =>
        json(
          { statusCode: 403, message: 'Your business requires two-factor sign-in for your role' },
          403,
        ),
    });
    expect(await screen.findByText('Recovery codes left: 3')).toBeInTheDocument();
    expect(screen.getByText('Your business requires this for your role.')).toBeInTheDocument();

    const off = form('Turn off two-factor sign-in');
    await user.type(
      within(off).getByRole('textbox', { name: 'Code from the app or a recovery code' }),
      '123456',
    );
    await user.click(within(off).getByRole('button', { name: 'Turn off' }));
    expect(await within(off).findByRole('alert')).toHaveTextContent(
      'Your business requires two-factor sign-in for your role',
    );

    const renew = form('New recovery codes');
    expect(within(renew).getByText('Your old recovery codes stop working.')).toBeInTheDocument();
    await user.type(
      within(renew).getByRole('textbox', { name: 'Code from the app or a recovery code' }),
      'abcd-efgh',
    );
    await user.click(within(renew).getByRole('button', { name: 'Get new codes' }));
    expect(await screen.findByRole('list', { name: 'Recovery codes' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'I have saved my recovery codes' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('form', { name: 'New recovery codes' })).toBeInTheDocument();
    expect(requests.find((request) => request.path === '/auth/2fa/recovery-codes')?.body).toEqual({
      code: 'abcd-efgh',
    });
  });

  it('turns it off with a current code, showing field problems on the field', async () => {
    let current = status({ enabled: true, recoveryCodesLeft: 10 });
    let answer = json(
      { statusCode: 400, message: 'Invalid request', issues: [{ path: 'code', message: 'Bad' }] },
      400,
    );
    const { user } = renderSecurity(CASHIER, {
      'GET /auth/2fa': () => json(current),
      'POST /auth/2fa/disable': () => answer,
    });
    const off = await screen.findByRole('form', { name: 'Turn off two-factor sign-in' });
    const box = within(off).getByRole('textbox', { name: 'Code from the app or a recovery code' });
    await user.type(box, '123456');
    await user.click(within(off).getByRole('button', { name: 'Turn off' }));
    expect(await within(off).findByText('Bad')).toBeInTheDocument();
    expect(within(off).queryByRole('alert')).toBeNull();

    answer = { status: 204, body: undefined };
    current = status();
    await user.type(box, '654321');
    await user.click(within(off).getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText('Two-factor sign-in is off')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Add an authenticator app' })).toBeVisible();
  });

  it('offers a retry when the settings cannot be loaded', async () => {
    let attempts = 0;
    const { user } = renderSecurity(CASHIER, {
      'GET /auth/2fa': () => {
        attempts += 1;
        return attempts === 1 ? json({ message: 'Database down' }, 503) : json(status());
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Database down');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Off')).toBeInTheDocument();
  });
});

describe('business sign-in rules', () => {
  it('lets owners and admins turn the requirement off and on', async () => {
    let attempts = 0;
    let answer: FakeHandler = (request) => json(request.body);
    const { user, requests } = renderSecurity(ADMIN, {
      'GET /auth/2fa': () => json(status({ enabled: true, required: true })),
      'GET /organization/security': () => {
        attempts += 1;
        return attempts === 1
          ? json({ message: 'Database down' }, 503)
          : json({ twoFactorRequired: true });
      },
      'PUT /organization/security': (request) => answer(request),
    });
    const rules = await screen.findByRole('region', { name: 'Business sign-in rules' });
    expect(await within(rules).findByRole('alert')).toHaveTextContent('Database down');
    await user.click(within(rules).getByRole('button', { name: 'Try again' }));
    const toggle = await within(rules).findByRole('checkbox', {
      name: 'Require two-factor sign-in for owners and admins',
    });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(
      'Recommended. Owners and organisation admins add an authenticator app at their next sign-in.',
    );
    // Admins are not owners: no team resets.
    expect(screen.queryByRole('region', { name: 'Team two-factor sign-in' })).toBeNull();

    await user.click(toggle);
    expect(await screen.findByText('Sign-in rules saved')).toBeInTheDocument();
    await waitFor(() => {
      expect(toggle).not.toBeChecked();
    });
    expect(requests.find((request) => request.method === 'PUT')?.body).toEqual({
      twoFactorRequired: false,
    });

    answer = () => json({ statusCode: 403, message: 'You do not have permission' }, 403);
    await user.click(toggle);
    expect(await screen.findByText('You do not have permission')).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
  });
});

describe('team two-factor resets', () => {
  it('points owners to the team, where each member can be reset', async () => {
    const { user } = renderSecurity(OWNER, {
      'GET /auth/2fa': () => json(status({ enabled: true, required: true })),
      'GET /organization/security': () => json({ twoFactorRequired: true }),
      'GET /members': () => json([]),
      'GET /stores': () => json([]),
    });
    const team = await screen.findByRole('region', { name: 'Team two-factor sign-in' });
    expect(
      within(team).getByText(
        'Owners reset a team member’s two-factor sign-in from their page under Team.',
      ),
    ).toBeInTheDocument();
    await user.click(within(team).getByRole('link', { name: 'Open the team' }));
    expect(await screen.findByRole('heading', { name: 'Team', level: 1 })).toBeVisible();
  });
});
