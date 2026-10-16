import type { PlanChangeResult, SubscriptionView } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHECKOUT,
  INVOICE,
  PAID_VIEW,
  subscriptionView,
} from '../test-support/billing-fixtures.js';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';

const ADMIN = profile(undefined, { role: { key: 'org_admin', name: 'Organization Admin' } });
const location = () => screen.getByTestId('location').textContent;

function renderBilling(path: string, routes: Record<string, FakeHandler>, me = OWNER) {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(me),
      'GET /subscription/invoices': () => json([]),
      ...routes,
    },
  });
}

const offer = (name: string) => {
  const item = screen
    .getAllByRole('listitem')
    .find((li) => li.querySelector('strong')?.textContent === name);
  return found(item);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('billing for a business on its trial', () => {
  it('shows the trial and upgrades through the gateway’s checkout', async () => {
    let paid = false;
    const { user, requests } = renderBilling('/settings/billing', {
      'GET /subscription': () => json(paid ? PAID_VIEW : subscriptionView()),
      'POST /subscription/change': () =>
        json({ kind: 'checkout', checkout: CHECKOUT } satisfies PlanChangeResult),
      'GET /subscription/checkouts/:id': () => json(CHECKOUT),
      'POST /subscription/checkouts/:id/fake-pay': () => {
        paid = true;
        return json({ ...CHECKOUT, status: 'paid' });
      },
    });
    expect(await screen.findByRole('heading', { name: 'Billing', level: 1 })).toBeVisible();
    const current = await screen.findByRole('region', { name: 'Your plan' });
    expect(current).toHaveTextContent('Trial Free trial');
    expect(current).toHaveTextContent('Trial ends26 Oct 2026 · 10 days left');
    expect(current).not.toHaveTextContent('Payment');
    expect(within(current).queryByRole('button')).toBeNull();
    expect(screen.getByRole('region', { name: 'Usage' })).toHaveTextContent(
      'Active stores3 of 5Team members13 of 25',
    );
    const plans = screen.getByRole('region', { name: 'Plans' });
    expect(plans).toHaveTextContent('You are billed for 3 stores.');
    expect(offer('Starter')).toHaveTextContent('₹799.00 per store a month');
    expect(offer('Starter')).toHaveTextContent('You have 3 active stores; this plan allows 1');
    expect(offer('Starter')).toHaveTextContent('You have 13 team members; this plan allows 5');
    expect(within(offer('Starter')).getByRole('button')).toBeDisabled();
    expect(offer('Standard')).toHaveTextContent('Up to 10 stores and 50 team members');
    expect(offer('Standard')).toHaveTextContent('₹4,497.00 + GST ₹809.46 = ₹5,306.46');
    expect(offer('Enterprise')).toHaveTextContent('No limit on stores or team members');
    expect(await screen.findByText('No invoices yet')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Plan history' })).toHaveTextContent(
      'Started on TrialSign-up · 12 Oct 2026, 10:00 am',
    );

    await user.selectOptions(
      within(plans).getByRole('combobox', { name: 'Billing period' }),
      'annual',
    );
    expect(offer('Standard')).toHaveTextContent('₹14,990.00 per store a year');
    await user.selectOptions(
      within(plans).getByRole('combobox', { name: 'Billing period' }),
      'monthly',
    );
    await user.click(within(offer('Standard')).getByRole('button', { name: 'Upgrade: Standard' }));
    expect(await screen.findByRole('heading', { name: 'Pay for your plan' })).toBeVisible();
    expect(location()).toBe(`/billing/checkout/${CHECKOUT.id}`);
    expect(await screen.findByText('Test payment – no money is taken')).toBeVisible();
    expect(screen.getByText('Standard')).toBeVisible();
    expect(screen.getByText('3 stores')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Pay ₹5,306.46' }));
    expect(await screen.findByText('Payment received. Your plan is active.')).toBeVisible();
    await waitFor(() => {
      expect(location()).toBe('/settings/billing');
    });
    expect(
      await within(await screen.findByRole('region', { name: 'Your plan' })).findByText('Active'),
    ).toBeVisible();
    expect(
      requests.filter((request) => request.method === 'POST').map((request) => request.body),
    ).toEqual([{ plan: 'standard', interval: 'monthly' }, {}]);
  });

  it('opens a real gateway’s own payment page, and shows refusals', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    let refuse = true;
    const { user } = renderBilling('/settings/billing', {
      'GET /subscription': () => json(subscriptionView()),
      'POST /subscription/change': () => {
        if (refuse) {
          refuse = false;
          return json({ message: 'The Standard plan is not available' }, 409);
        }
        return json({
          kind: 'checkout',
          checkout: { ...CHECKOUT, gateway: 'razorpay', checkoutUrl: 'https://rzp.io/i/pay1' },
        });
      },
    });
    const button = await screen.findByRole('button', { name: 'Upgrade: Standard' });
    await user.click(button);
    expect(await screen.findByText('The Standard plan is not available')).toBeVisible();
    await user.click(button);
    await waitFor(() => {
      expect(open).toHaveBeenCalledWith('https://rzp.io/i/pay1', '_self');
    });
  });
});

describe('billing for a paying business', () => {
  it('changes the plan in place, cancels at period end and downloads invoices', async () => {
    let view: SubscriptionView = PAID_VIEW;
    const createObjectURL = vi.fn(() => 'blob:invoice');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    let failDownload = true;
    const { user } = renderBilling('/settings/billing', {
      'GET /subscription': () => json(view),
      'GET /subscription/invoices': () => json([INVOICE]),
      'GET /subscription/invoices/:id/pdf': () => {
        if (failDownload) {
          failDownload = false;
          return json({ message: 'Invoice not found' }, 404);
        }
        return { status: 200, raw: '%PDF-', headers: { 'content-type': 'application/pdf' } };
      },
      'POST /subscription/change': () => {
        view = subscriptionView({
          ...PAID_VIEW,
          plan: 'enterprise',
          planName: 'Enterprise',
          limits: { maxStores: null, maxMembers: null },
        });
        return json({ kind: 'changed', subscription: view } satisfies PlanChangeResult);
      },
      'POST /subscription/cancel': () => {
        view = { ...view, cancelAtPeriodEnd: true };
        return json(view);
      },
    });
    const current = await screen.findByRole('region', { name: 'Your plan' });
    expect(current).toHaveTextContent('Renews16 Nov 2026');
    expect(current).toHaveTextContent('BilledMonthly · 3 stores');
    expect(current).toHaveTextContent('PaymentPaid online');
    expect(
      within(offer('Standard')).getByRole('button', { name: 'Current plan: Standard' }),
    ).toBeDisabled();
    expect(
      within(offer('Starter')).getByRole('button', { name: 'Downgrade: Starter' }),
    ).toBeDisabled();
    expect(screen.getByRole('region', { name: 'Plan history' })).toHaveTextContent(
      'Trial → StandardBy Anil Kumar · Monthly · 16 Oct 2026, 10:00 am',
    );

    const table = await screen.findByRole('table', { name: 'Our invoices to you' });
    expect(table).toHaveTextContent('PRS/26-27/000001');
    expect(table).toHaveTextContent('16 Oct 2026 – 15 Nov 2026');
    expect(table).toHaveTextContent('Standard, Monthly');
    expect(table).toHaveTextContent('₹5,306.46');
    const download = within(table).getByRole('button', {
      name: 'Download PDF: PRS/26-27/000001',
    });
    await user.click(download);
    expect(await screen.findByText('Invoice not found')).toBeVisible();
    await user.click(download);
    await waitFor(() => {
      expect(click).toHaveBeenCalled();
    });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Billing period' }), 'annual');
    expect(
      within(offer('Standard')).getByRole('button', { name: 'Choose: Standard' }),
    ).toBeEnabled();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Billing period' }), 'monthly');
    await user.click(screen.getByRole('button', { name: 'Upgrade: Enterprise' }));
    expect(await screen.findByText('You are now on the Enterprise plan')).toBeVisible();
    expect(
      await within(await screen.findByRole('region', { name: 'Usage' })).findByText('3 (no limit)'),
    ).toBeVisible();

    await user.click(
      within(screen.getByRole('region', { name: 'Your plan' })).getByRole('button', {
        name: 'Cancel at the end of the period',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Cancel the subscription?' });
    expect(dialog).toHaveTextContent('Everything keeps working until 16 Nov 2026.');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel subscription' }));
    expect(await screen.findByText('The subscription ends on 16 Nov 2026')).toBeVisible();
    const after = screen.getByRole('region', { name: 'Your plan' });
    expect(after).toHaveTextContent('Paid until16 Nov 2026');
    expect(after).toHaveTextContent('The subscription ends on 16 Nov 2026 and will not renew.');
    expect(within(after).queryByRole('button')).toBeNull();
  });

  it('closes the cancel dialog without cancelling', async () => {
    const { user, requests } = renderBilling('/settings/billing', {
      'GET /subscription': () => json(PAID_VIEW),
    });
    await user.click(
      await screen.findByRole('button', { name: 'Cancel at the end of the period' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it.each([
    [
      'past due, in its grace period',
      { status: 'past_due', graceEndsAt: '2026-10-23T04:30:00.000Z' },
      'Your last payment did not go through. Pay by 23 Oct 2026 to keep working without a break.',
    ],
    [
      'past due and read-only',
      { status: 'past_due', readOnly: true, graceEndsAt: '2026-10-10T04:30:00.000Z' },
      'The business is read-only',
    ],
    [
      'ended after cancelling',
      { status: 'cancelled', readOnly: true, cancelAtPeriodEnd: true },
      'The business is read-only',
    ],
  ] as const)('warns when %s', async (_, change, text) => {
    renderBilling('/settings/billing', {
      'GET /subscription': () => json({ ...PAID_VIEW, ...change }),
    });
    const current = await screen.findByRole('region', { name: 'Your plan' });
    expect(current).toHaveTextContent(text);
    expect(current).not.toHaveTextContent('will not renew');
    expect(within(current).queryByRole('button', { name: /Cancel/ })).toBeNull();
  });

  it('explains a plan set by our team, and an expired trial', async () => {
    const { unmount } = renderBilling('/settings/billing', {
      'GET /subscription': () =>
        json(
          subscriptionView({
            plan: 'standard',
            planName: 'Standard',
            status: 'active',
            trialEndsAt: null,
            trialDaysLeft: null,
          }),
        ),
    });
    const current = await screen.findByRole('region', { name: 'Your plan' });
    expect(current).toHaveTextContent('PaymentSet by our team');
    expect(current).toHaveTextContent('Your plan was set by our team');
    expect(
      within(offer('Standard')).getByRole('button', { name: 'Choose: Standard' }),
    ).toBeEnabled();
    unmount();

    renderBilling('/settings/billing', {
      'GET /subscription': () =>
        json(subscriptionView({ status: 'expired', readOnly: true, trialDaysLeft: null })),
    });
    const expired = await screen.findByRole('region', { name: 'Your plan' });
    expect(expired).toHaveTextContent('Trial ended');
    expect(expired).toHaveTextContent('Trial ends26 Oct 2026');
    expect(expired).not.toHaveTextContent('days left');
  });

  it('says when the subscription or the invoices cannot be loaded', async () => {
    renderBilling('/settings/billing', {
      'GET /subscription': () => json({ message: 'Down for maintenance' }, 503),
    });
    expect(await screen.findByText('Could not load your subscription')).toBeVisible();
  });
});

describe('the fake checkout', () => {
  it('says when the payment is already done, and shows a failed payment', async () => {
    const { unmount } = renderBilling(`/billing/checkout/${CHECKOUT.id}`, {
      'GET /subscription/checkouts/:id': () => json({ ...CHECKOUT, status: 'paid' }),
    });
    expect(await screen.findByText('This payment is already done.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to billing' })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
    expect(screen.queryByRole('button', { name: /Pay/ })).toBeNull();
    unmount();

    const { user } = renderBilling(`/billing/checkout/${CHECKOUT.id}`, {
      'GET /subscription/checkouts/:id': () => json(CHECKOUT),
      'POST /subscription/checkouts/:id/fake-pay': () =>
        json({ message: 'This checkout is already paid' }, 409),
    });
    await user.click(await screen.findByRole('button', { name: 'Pay ₹5,306.46' }));
    expect(await screen.findByText('This checkout is already paid')).toBeVisible();
    expect(location()).toBe(`/billing/checkout/${CHECKOUT.id}`);
  });
});

describe('billing for anyone but the owner', () => {
  it.each(['/settings/billing', `/billing/checkout/${CHECKOUT.id}`])(
    'tells an admin that %s is for the owner',
    async (path) => {
      const { requests } = renderBilling(path, {}, ADMIN);
      expect(await screen.findByText('Only the owner manages billing')).toBeVisible();
      expect(requests.some((request) => request.path.startsWith('/subscription/check'))).toBe(
        false,
      );
    },
  );
});
