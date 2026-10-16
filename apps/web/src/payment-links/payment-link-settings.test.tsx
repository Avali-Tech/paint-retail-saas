import { SYSTEM_ROLES, type GatewayAccountView, type PaymentLinkSummary } from '@paint/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/i18n.js';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { parseRules } from './PaymentLinkSettingsPage.js';
import { RefundNote } from './PaymentLinks.js';

const RULES = { validityMinutes: 10, capPaise: 10_000_000, amountBasis: 'net' as const };
const RAZORPAY = { provider: 'razorpay', ready: false, ...RULES };
const WEBHOOK = 'https://api.example.in/webhooks/payment-links/razorpay/abcdefghijklmnopqrstuv';
const ACCOUNT = (overrides: Partial<GatewayAccountView> = {}): GatewayAccountView => ({
  gateway: 'razorpay',
  connected: false,
  live: null,
  keyIdHint: null,
  keySecretHint: null,
  webhookSecretHint: null,
  connectedAt: null,
  connectedBy: null,
  verifiedAt: null,
  webhookUrl: WEBHOOK,
  ...overrides,
});
const CONNECTED = ACCOUNT({
  connected: true,
  live: true,
  keyIdHint: 'FIKMb'.slice(-4),
  keySecretHint: 'wxyz',
  webhookSecretHint: '1234',
  connectedAt: '2026-10-16T05:00:00.000Z',
  connectedBy: 'Anil Kumar',
  verifiedAt: '2026-10-16T05:00:00.000Z',
});
const KEYS = {
  keyId: 'rzp_live_ILgsfZCZoFIKMb',
  keySecret: 'liveKeySecretABCDEFGH1234',
  webhookSecret: 'shop-webhook-secret',
};

describe('Settings → Payment links', { timeout: 30_000 }, () => {
  it('connects the business’s own Razorpay account and never shows its keys again', async () => {
    let account = ACCOUNT();
    const { user, requests } = renderApp({
      path: '/settings/payment-links',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /payment-links/settings': () => json(RAZORPAY),
        'GET /payment-links/gateway-account': () => json(account),
        'PUT /payment-links/gateway-account': () => {
          account = CONNECTED;
          return json(CONNECTED);
        },
      },
    });
    const card = await screen.findByRole('region', { name: 'Razorpay account' });
    expect(within(card).getByText('Not connected')).toBeVisible();
    expect(within(card).getByText(WEBHOOK)).toBeVisible();
    expect(within(card).getByText(/payment_link\.paid, payment_link\.expired/)).toBeVisible();
    await user.click(within(card).getByRole('button', { name: 'Copy link webhook address' }));
    expect(await navigator.clipboard.readText()).toBe(WEBHOOK);

    // Incomplete keys are refused here, before anything is sent.
    await user.type(within(card).getByLabelText('Key id'), 'rzp_x');
    await user.click(within(card).getByRole('button', { name: 'Connect Razorpay' }));
    expect(await within(card).findByText(/Enter the key id/)).toBeVisible();
    await user.clear(within(card).getByLabelText('Key id'));

    await user.type(within(card).getByLabelText('Key id'), KEYS.keyId);
    const secret = within(card).getByLabelText('Key secret');
    expect(secret).toHaveAttribute('type', 'password');
    await user.type(secret, KEYS.keySecret);
    await user.type(within(card).getByLabelText('Webhook secret'), KEYS.webhookSecret);
    await user.click(within(card).getByRole('button', { name: 'Connect Razorpay' }));
    expect(await screen.findByText('Razorpay connected')).toBeVisible();
    expect(
      requests.find(
        (request) => request.method === 'PUT' && request.path === '/payment-links/gateway-account',
      )?.body,
    ).toEqual(KEYS);
    expect(await within(card).findByText('Connected · live')).toBeVisible();
    expect(within(card).getByText('••••wxyz')).toBeVisible();
    expect(within(card).getByText('••••1234')).toBeVisible();
    // The keys left the form once kept.
    expect(within(card).getByLabelText('Key secret')).toHaveValue('');
    expect(document.body.textContent).not.toContain(KEYS.keySecret);
    expect(within(card).getByRole('button', { name: 'Replace keys' })).toBeVisible();
  });

  it('tests and disconnects the account, and says what Razorpay answered', async () => {
    let account = CONNECTED;
    const { user } = renderApp({
      path: '/settings/payment-links',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /payment-links/settings': () => json({ ...RAZORPAY, ready: true }),
        'GET /payment-links/gateway-account': () => json(account),
        'POST /payment-links/gateway-account/test': () =>
          json({ ok: true, verifiedAt: '2026-10-16T06:00:00.000Z' }),
        'DELETE /payment-links/gateway-account': () => {
          account = ACCOUNT();
          return json(account);
        },
        'PUT /payment-links/gateway-account': () =>
          json(
            {
              statusCode: 409,
              code: 'gateway_rejected',
              message: 'Razorpay did not accept these keys: check the key id and key secret',
            },
            409,
          ),
      },
    });
    const card = await screen.findByRole('region', { name: 'Razorpay account' });
    await user.click(await within(card).findByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Razorpay answered: the keys work')).toBeVisible();

    await user.type(within(card).getByLabelText('Key id'), KEYS.keyId);
    await user.type(within(card).getByLabelText('Key secret'), KEYS.keySecret);
    await user.type(within(card).getByLabelText('Webhook secret'), KEYS.webhookSecret);
    await user.click(within(card).getByRole('button', { name: 'Replace keys' }));
    expect(await within(card).findByText(/Razorpay did not accept these keys/)).toBeVisible();

    await user.click(within(card).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText(/Razorpay disconnected/)).toBeVisible();
    expect(await within(card).findByText('Not connected')).toBeVisible();
  });

  it('warns that test keys take no money, and shows a failed test', async () => {
    const { user } = renderApp({
      path: '/settings/payment-links',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /payment-links/settings': () => json({ ...RAZORPAY, ready: true }),
        'GET /payment-links/gateway-account': () =>
          json({ ...CONNECTED, live: false, connectedBy: null, verifiedAt: null }),
        'POST /payment-links/gateway-account/test': () =>
          json(
            {
              statusCode: 409,
              code: 'gateway_rejected',
              message: 'Razorpay could not be checked just now (unreachable): try again',
            },
            409,
          ),
      },
    });
    const card = await screen.findByRole('region', { name: 'Razorpay account' });
    expect(await within(card).findByText('Connected · test')).toBeVisible();
    expect(within(card).getByText(/Test keys take no money/)).toBeVisible();
    await user.click(within(card).getByRole('button', { name: 'Test connection' }));
    expect(await within(card).findByText(/could not be checked just now/)).toBeVisible();
  });

  it('saves how long links live, their cap and what they ask for', async () => {
    const { user, requests } = renderApp({
      path: '/settings/payment-links',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /payment-links/settings': () => json({ provider: 'log', ready: true, ...RULES }),
        'PUT /payment-links/settings': (request) =>
          json({ provider: 'log', ready: true, ...(request.body as object) }),
      },
    });
    expect(await screen.findByText(/Links use the test gateway here/)).toBeVisible();
    const rules = screen.getByRole('region', { name: 'How links work' });
    const validity = within(rules).getByLabelText('Payable for (minutes)');
    expect(validity).toHaveValue('10');
    expect(within(rules).getByLabelText('Most one link asks for (₹)')).toHaveValue('100000.00');
    await user.clear(validity);
    await user.type(validity, '2');
    const capInput = within(rules).getByLabelText('Most one link asks for (₹)');
    await user.clear(capInput);
    await user.type(capInput, '900000');
    await user.click(within(rules).getByRole('button', { name: 'Save' }));
    expect(await within(rules).findByText('Enter 5 to 43200 minutes')).toBeVisible();
    expect(within(rules).getByText('Enter ₹1.00 to ₹5,00,000.00')).toBeVisible();
    await user.clear(validity);
    await user.type(validity, '30');
    const cap = within(rules).getByLabelText('Most one link asks for (₹)');
    await user.clear(cap);
    await user.type(cap, '50000');
    await user.selectOptions(within(rules).getByLabelText('Links ask for'), 'full');
    expect(within(rules).getByText(/The link asks for the bills in full/)).toBeVisible();
    await user.click(within(rules).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Payment link settings saved')).toBeVisible();
    expect(
      requests.find(
        (request) => request.method === 'PUT' && request.path === '/payment-links/settings',
      )?.body,
    ).toEqual({ validityMinutes: 30, capPaise: 5_000_000, amountBasis: 'full' });
  });

  it('shows why saving failed, and that links are off', async () => {
    const { user } = renderApp({
      path: '/settings/payment-links',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /payment-links/settings': () => json({ provider: null, ready: false, ...RULES }),
        'PUT /payment-links/settings': () =>
          json({ statusCode: 400, message: 'Invalid request', issues: [] }, 400),
      },
    });
    expect(
      await screen.findByText('Payment links are not switched on for this service.'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Invalid request')).toBeVisible();
  });

  it('is for owners and admins only', async () => {
    const sales = profile(
      SYSTEM_ROLES.find((role) => role.key === 'sales_executive')?.permissions,
      {
        role: { key: 'sales_executive', name: 'Sales Executive' },
      },
    );
    renderApp({
      path: '/settings/payment-links',
      routes: {
        'GET /auth/me': () => json(sales),
        'GET /payment-links/settings': () => json(RAZORPAY),
      },
    });
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Razorpay account' })).toBeNull();
    });
    expect(await screen.findByText(/permission|not allowed|access/i)).toBeVisible();
  });
});

describe('parseRules', () => {
  it('checks the rules as the API does', () => {
    expect(parseRules({ validityMinutes: '10', cap: '1000', amountBasis: 'net' })).toEqual({
      ok: true,
      input: { validityMinutes: 10, capPaise: 100_000, amountBasis: 'net' },
    });
    expect(parseRules({ validityMinutes: '1.5', cap: 'abc', amountBasis: 'net' })).toEqual({
      ok: false,
      problems: { validityMinutes: 'range', cap: 'range' },
    });
    expect(parseRules({ validityMinutes: '43201', cap: '500001', amountBasis: 'full' })).toEqual({
      ok: false,
      problems: { validityMinutes: 'range', cap: 'range' },
    });
    expect(parseRules({ validityMinutes: '5', cap: '0.99', amountBasis: 'full' }).ok).toBe(false);
  });
});

describe('RefundNote', () => {
  const LINK = {
    refundedPaise: 0,
    refundPendingPaise: 0,
    refundFailed: false,
  } as PaymentLinkSummary;
  const note = (overrides: Partial<PaymentLinkSummary>) =>
    render(
      <I18nProvider>
        <RefundNote link={{ ...LINK, ...overrides }} />
      </I18nProvider>,
    );

  it('says what went back through the gateway, what is on its way, and what failed', () => {
    const { container } = note({});
    expect(container.textContent).toBe('');
    note({ refundedPaise: 82_00 });
    expect(screen.getByText('Refunded ₹82.00')).toBeVisible();
    note({ refundPendingPaise: 50_00 });
    expect(screen.getByText('Refund of ₹50.00 on its way')).toBeVisible();
    note({ refundPendingPaise: 40_00, refundFailed: true });
    expect(screen.getByText('Refund of ₹40.00 failed: kept as an advance')).toBeVisible();
  });
});
