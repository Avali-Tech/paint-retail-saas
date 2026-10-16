import type { SubscriptionStatusView } from '@paint/shared';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { subscriptionStatus } from '../test-support/billing-fixtures.js';
import { CASHIER, DASHBOARD, OWNER, json, profile } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';

function renderShell(status: SubscriptionStatusView | null, me = OWNER) {
  return renderApp({
    path: '/dashboard',
    routes: {
      'GET /auth/me': () => json(me),
      'GET /dashboard': () => json(DASHBOARD),
      'GET /subscription/status': () =>
        status === null ? json({ message: 'Down' }, 503) : json(status),
    },
  });
}

const banner = async (title: string) => {
  const alert = await screen.findByText(title);
  return alert.closest('.ui-alert');
};

describe('the subscription banner for the owner', () => {
  it.each([
    [
      { status: 'trialing', trialDaysLeft: 5, trialEndsAt: '2026-10-21T04:30:00.000Z' },
      'Your free trial ends in 5 days',
      'Choose a plan to keep working without a break.',
    ],
    [
      { status: 'trialing', trialDaysLeft: 1, trialEndsAt: '2026-10-17T04:30:00.000Z' },
      'Your free trial ends tomorrow',
      'Choose a plan to keep working without a break.',
    ],
    [
      { status: 'expired', readOnly: true },
      'Your free trial has ended',
      'The business is read-only. Choose a plan to continue.',
    ],
    [
      { status: 'past_due', graceEndsAt: '2026-10-23T04:30:00.000Z' },
      'Payment overdue',
      'Pay by 23 Oct 2026 to avoid read-only mode.',
    ],
    [
      { status: 'past_due', readOnly: true, graceEndsAt: '2026-10-10T04:30:00.000Z' },
      'The business is read-only',
      'Nothing new can be saved until the subscription is paid.',
    ],
    [{ cancelAtPeriodEnd: true }, 'Your subscription ends on 16 Nov 2026', 'It will not renew.'],
  ] as const)('warns about %o', async (change, title, text) => {
    renderShell(subscriptionStatus(change));
    const alert = await banner(title);
    expect(alert).toHaveTextContent(text);
    expect(screen.getByRole('link', { name: 'Open billing' })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
  });

  it('says nothing while all is well, a trial has long to run, or the status cannot load', async () => {
    for (const status of [
      subscriptionStatus(),
      subscriptionStatus({ status: 'trialing', trialDaysLeft: 12 }),
      null,
    ]) {
      const { unmount } = renderShell(status);
      expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeVisible();
      expect(screen.queryByRole('link', { name: 'Open billing' })).toBeNull();
      unmount();
    }
  });
});

describe('the subscription banner for everyone else', () => {
  it('only says when the business is read-only', async () => {
    const { unmount } = renderShell(
      subscriptionStatus({
        status: 'past_due',
        readOnly: true,
        graceEndsAt: '2026-10-10T04:30:00.000Z',
      }),
      CASHIER,
    );
    expect(await banner('The business is read-only')).toHaveTextContent(
      'Nothing new can be saved until the owner pays for the subscription.',
    );
    expect(screen.queryByRole('link', { name: 'Open billing' })).toBeNull();
    unmount();

    const { services } = renderShell(
      subscriptionStatus({ status: 'trialing', trialDaysLeft: 2 }),
      CASHIER,
    );
    await waitFor(() => {
      expect(services.queryClient.getQueryData(['subscription', 'status'])).toBeDefined();
    });
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeVisible();
    expect(screen.queryByText('Your free trial ends in 2 days')).toBeNull();
  });

  it('is never shown in platform support’s view', async () => {
    const { requests } = renderShell(
      subscriptionStatus({ status: 'expired', readOnly: true }),
      profile(['stores:read'], { role: { key: 'support', name: 'Platform support' } }),
    );
    expect(await screen.findByText('Support view – read only')).toBeVisible();
    expect(screen.queryByText('Your free trial has ended')).toBeNull();
    expect(requests.some((request) => request.path === '/subscription/status')).toBe(false);
  });
});
