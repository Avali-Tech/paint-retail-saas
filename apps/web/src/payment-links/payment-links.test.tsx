import {
  SYSTEM_ROLES,
  emptyTotals,
  type LogCheckoutView,
  type LogWebhook,
  type PaymentLinkCreated,
  type PaymentLinkPage,
  type PaymentLinkSummary,
  type PaymentLinkView,
  type StatementData,
  type StatementShareResult,
  type WorklistPage,
} from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { OVERVIEW, PARTY, STORES } from '../test-support/party-fixtures.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import { ADJUSTMENTS, INVOICE } from '../test-support/sales-fixtures.js';

const SUMMARY = (overrides: Partial<PaymentLinkSummary> = {}): PaymentLinkSummary => ({
  id: 'link-1',
  number: 'PL-000001',
  storeId: 'store-1',
  partyId: PARTY.id,
  partyName: 'Apex Builders',
  purpose: 'invoice',
  origin: 'staff',
  amountPaise: 1_180_00,
  paidPaise: 0,
  status: 'created',
  url: 'https://app.example.in/pay/plink_log_aaaaaaaaaaaaaaaaaaaaaa',
  expiresAt: '2026-10-23T05:00:00.000Z',
  createdAt: '2026-10-16T05:00:00.000Z',
  refundedPaise: 0,
  refundPendingPaise: 0,
  refundFailed: false,
  ...overrides,
});

const VIEW: PaymentLinkView = {
  ...SUMMARY(),
  description: 'ABC Paints: Invoice AMP/26-27/000001',
  provider: 'log',
  paidAt: null,
  cancelledAt: null,
  createdBy: 'Anil Kumar',
  documents: [],
  payments: [],
  refunds: [],
};

const CREATED = (overrides: Partial<PaymentLinkCreated> = {}): PaymentLinkCreated => ({
  link: VIEW,
  waMeUrl: 'https://wa.me/919876543210?text=Pay',
  message: null,
  ...overrides,
});

const PAGE = (items: PaymentLinkSummary[], total = items.length): PaymentLinkPage => ({
  items,
  total,
});

const RULES = { validityMinutes: 10, capPaise: 10_000_000, amountBasis: 'net' };
const ON = { provider: 'log', ready: true, ...RULES };
const OFF = { provider: null, ready: false, ...RULES };

const SALES = profile(SYSTEM_ROLES.find((r) => r.key === 'sales_executive')?.permissions, {
  role: { key: 'sales_executive', name: 'Sales Executive' },
});
const EMPLOYEE = profile(SYSTEM_ROLES.find((r) => r.key === 'store_employee')?.permissions, {
  role: { key: 'store_employee', name: 'Store Employee' },
});

const invoiceRoutes = (extra: Record<string, FakeHandler> = {}) => ({
  'GET /auth/me': () => json(OWNER),
  'GET /invoices/:id': () => json(INVOICE),
  'GET /invoices/:id/adjustments': () => json(ADJUSTMENTS),
  'GET /payment-links/settings': () => json(ON),
  'GET /messaging/status': () => json({ whatsapp: null, sms: false, email: false }),
  'GET /payment-links': () => json(PAGE([])),
  ...extra,
});

describe('payment links on an invoice', { timeout: 30_000 }, () => {
  it('sends a link for the invoice and shows where to pay and share it', async () => {
    const { user, requests } = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: invoiceRoutes({
        'POST /payment-links': () =>
          json(CREATED({ message: null, waMeUrl: 'https://wa.me/919876543210?text=Pay' }), 201),
      }),
    });
    const panel = await screen.findByRole('region', { name: 'UPI payment links' });
    expect(await within(panel).findByText('No payment link has been sent yet.')).toBeVisible();
    expect(
      requests.find((request) => request.path === '/payment-links')?.query.get('invoiceId'),
    ).toBe(INVOICE.id);

    await user.click(within(panel).getByRole('button', { name: 'Send a payment link to Lakshmi' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send a UPI payment link' });
    expect(within(dialog).getByText('For invoice AMP/26-27/000001')).toBeVisible();
    // Without WhatsApp set up there is nothing to tick.
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Make link' }));

    const result = await screen.findByRole('dialog', { name: 'Payment link PL-000001' });
    const sent = requests.find(
      (request) => request.method === 'POST' && request.path === '/payment-links',
    );
    expect(sent?.body).toEqual({
      partyId: 'party-1',
      purpose: 'invoice',
      invoiceId: INVOICE.id,
    });
    expect(sent?.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(within(result).getByText(VIEW.url)).toBeVisible();
    expect(within(result).getByRole('link', { name: 'Share on WhatsApp' })).toHaveAttribute(
      'href',
      'https://wa.me/919876543210?text=Pay',
    );
    await user.click(within(result).getByRole('button', { name: 'Copy link PL-000001' }));
    expect(await screen.findByText('Link copied')).toBeVisible();
    expect(await navigator.clipboard.readText()).toBe(VIEW.url);
    await user.click(within(result).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('tells whether the WhatsApp message went, and shows no wa.me without a mobile', async () => {
    const { user, requests } = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: invoiceRoutes({
        'GET /messaging/status': () => json({ whatsapp: 'log', sms: false, email: false }),
        'POST /payment-links': (request) =>
          json(
            CREATED({
              waMeUrl: null,
              message:
                (request.body as { amountPaise?: number }).amountPaise === 50_000
                  ? { queued: true, messageId: 'message-1' }
                  : { queued: false, reason: 'no_consent' },
            }),
            201,
          ),
      }),
    });
    const panel = await screen.findByRole('region', { name: 'UPI payment links' });
    await user.click(within(panel).getByRole('button', { name: 'Send a payment link to Lakshmi' }));
    let dialog = await screen.findByRole('dialog', { name: 'Send a UPI payment link' });
    await user.click(within(dialog).getByRole('checkbox', { name: 'Also send it on WhatsApp' }));
    await user.click(within(dialog).getByRole('button', { name: 'Make link' }));
    let result = await screen.findByRole('dialog', { name: 'Payment link PL-000001' });
    expect(within(result).getByText(/the customer has not agreed to messages/)).toBeVisible();
    expect(within(result).queryByRole('link', { name: 'Share on WhatsApp' })).toBeNull();
    await user.click(within(result).getByRole('button', { name: 'Close' }));

    await user.click(within(panel).getByRole('button', { name: 'Send a payment link to Lakshmi' }));
    dialog = await screen.findByRole('dialog', { name: 'Send a UPI payment link' });
    await user.type(within(dialog).getByLabelText(/Amount/), '500');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Also send it on WhatsApp' }));
    await user.click(within(dialog).getByRole('button', { name: 'Make link' }));
    result = await screen.findByRole('dialog', { name: 'Payment link PL-000001' });
    expect(within(result).getByText('Sent on WhatsApp.')).toBeVisible();
    expect(requests.filter((request) => request.method === 'POST').at(-1)?.body).toMatchObject({
      amountPaise: 50_000,
      send: 'whatsapp',
    });
  });

  it('lists the invoice’s links with their status, and cancels an open one', async () => {
    let cancelled = false;
    const { user } = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: invoiceRoutes({
        'GET /payment-links': () =>
          json(
            PAGE([
              SUMMARY({ status: cancelled ? 'cancelled' : 'created' }),
              SUMMARY({ id: 'link-2', number: 'PL-000002', status: 'paid', paidPaise: 1_180_00 }),
              SUMMARY({ id: 'link-3', number: 'PL-000003', paidPaise: 100_00 }),
            ]),
          ),
        'POST /payment-links/:id/cancel': () => {
          cancelled = true;
          return json({ ...VIEW, status: 'cancelled' });
        },
      }),
    });
    const panel = await screen.findByRole('region', { name: 'UPI payment links' });
    const items = await within(panel).findAllByRole('listitem');
    expect(items[0]).toHaveTextContent('PL-000001 · Invoice · ₹1,180.00 Open');
    expect(items[0]).toHaveTextContent('Payable until: 23 Oct 2026, 10:30 am');
    expect(items[1]).toHaveTextContent('Paid');
    expect(items[1]).toHaveTextContent('Paid: ₹1,180.00');
    expect(items[2]).toHaveTextContent('Part paid');
    // A paid link has nothing left to do.
    expect(within(found(items[1])).queryByRole('button')).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Cancel link PL-000001' }));
    expect(await screen.findByText('Link cancelled: it can no longer be paid')).toBeVisible();
    await waitFor(() => {
      expect(within(panel).getAllByRole('listitem')[0]).toHaveTextContent('Cancelled');
    });
  });

  it('says why a link was refused, or could not be cancelled, and checks the amount', async () => {
    const { user } = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: invoiceRoutes({
        'GET /payment-links': () => json(PAGE([SUMMARY()])),
        'POST /payment-links': () =>
          json(
            {
              statusCode: 409,
              code: 'link_not_open',
              message: 'Nothing is left to pay on this bill',
            },
            409,
          ),
        'POST /payment-links/:id/cancel': () =>
          json({ statusCode: 409, message: 'This link is already paid' }, 409),
      }),
    });
    const panel = await screen.findByRole('region', { name: 'UPI payment links' });
    await user.click(await within(panel).findByRole('button', { name: 'Cancel link PL-000001' }));
    expect(await screen.findByText('This link is already paid')).toBeVisible();

    await user.click(within(panel).getByRole('button', { name: 'Send a payment link to Lakshmi' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send a UPI payment link' });
    await user.type(within(dialog).getByLabelText(/Amount/), 'abc');
    await user.click(within(dialog).getByRole('button', { name: 'Make link' }));
    expect(
      await within(dialog).findByText('Enter an amount above zero, such as 2500'),
    ).toBeVisible();
    await user.clear(within(dialog).getByLabelText(/Amount/));
    await user.type(within(dialog).getByLabelText(/Amount/), '0');
    await user.click(within(dialog).getByRole('button', { name: 'Make link' }));
    expect(
      await within(dialog).findByText('Enter an amount above zero, such as 2500'),
    ).toBeVisible();
    await user.clear(within(dialog).getByLabelText(/Amount/));
    await user.click(within(dialog).getByRole('button', { name: 'Make link' }));
    expect(await within(dialog).findByText('Nothing is left to pay on this bill')).toBeVisible();
  });

  it('shows nothing when this server makes no links, or the list cannot be loaded', async () => {
    renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: invoiceRoutes({ 'GET /payment-links/settings': () => json(OFF) }),
    });
    expect((await screen.findAllByRole('region', { name: 'Lines' })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('region', { name: 'UPI payment links' })).toBeNull();
  });

  it('says when the links cannot be loaded, and leaves sending to who takes payments', async () => {
    renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: invoiceRoutes({
        'GET /auth/me': () => json(EMPLOYEE),
        'GET /payment-links': () => json({ message: 'Down' }, 500),
      }),
    });
    const panel = await screen.findByRole('region', { name: 'UPI payment links' });
    expect(await within(panel).findByText('Could not load the payment links')).toBeVisible();
    expect(within(panel).queryByRole('button')).toBeNull();
  });

  it('is not offered for a draft', async () => {
    renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: invoiceRoutes({
        'GET /invoices/:id': () => json({ ...INVOICE, status: 'draft', number: null }),
      }),
    });
    expect((await screen.findAllByRole('region', { name: 'Lines' })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('region', { name: 'UPI payment links' })).toBeNull();
  });
});

describe('payment links for a customer', { timeout: 30_000 }, () => {
  const partyRoutes = (extra: Record<string, FakeHandler> = {}) => ({
    'GET /auth/me': () => json(OWNER),
    'GET /parties/:id/overview': () => json(OVERVIEW),
    'GET /documents': () => json([]),
    'GET /stores': () => json(STORES),
    'GET /payment-links/settings': () => json(ON),
    'GET /messaging/status': () => json({ whatsapp: 'log', sms: false, email: false }),
    'GET /payment-links': () => json(PAGE([SUMMARY({ purpose: 'overdue', status: 'expired' })])),
    'POST /payment-links': () => json(CREATED(), 201),
    ...extra,
  });

  it('asks for an advance, which needs an amount, from the customer 360', async () => {
    const { user, requests } = renderApp({ path: `/parties/${PARTY.id}`, routes: partyRoutes() });
    const panel = await screen.findByRole('region', { name: 'UPI payment links' });
    expect(await within(panel).findByText(/Overdue bills/)).toBeVisible();
    expect(within(panel).getByText('Expired')).toBeVisible();
    expect(
      requests.find((request) => request.path === '/payment-links')?.query.get('partyId'),
    ).toBe(PARTY.id);
    await user.click(
      within(panel).getByRole('button', { name: 'Send a payment link to Apex Builders' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Send a UPI payment link' });
    expect(within(dialog).getByLabelText('Ask for')).toHaveValue('overdue');
    expect(within(dialog).getByText('Leave empty to ask for everything owed.')).toBeVisible();
    await user.selectOptions(within(dialog).getByLabelText('Ask for'), 'advance');
    expect(within(dialog).getByText('An advance needs an amount.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Make link' }));
    expect(
      await within(dialog).findByText('Enter an amount above zero, such as 2500'),
    ).toBeVisible();
    await user.type(within(dialog).getByLabelText(/Amount/), '2500');
    await user.click(within(dialog).getByRole('button', { name: 'Make link' }));
    await screen.findByRole('dialog', { name: 'Payment link PL-000001' });
    expect(
      requests.find((request) => request.method === 'POST' && request.path === '/payment-links')
        ?.body,
    ).toEqual({ partyId: PARTY.id, purpose: 'advance', amountPaise: 2_500_00 });
  });

  it('is sent from the ledger and the collections worklist too', async () => {
    const ledger = renderApp({
      path: `/parties/${PARTY.id}/ledger`,
      routes: partyRoutes({
        'GET /parties/:id': () => json(PARTY),
        'GET /parties/:id/ledger': () =>
          json({
            openingPaise: 0,
            closingPaise: 0,
            balancePaise: 0,
            advancePaise: 0,
            entries: [],
            openDocuments: [],
            total: 0,
            nextCursor: null,
          }),
      }),
    });
    expect(
      await screen.findByRole('button', { name: 'Send a payment link to Apex Builders' }),
    ).toBeVisible();
    ledger.unmount();

    const worklist: WorklistPage = {
      asOf: '2026-10-16',
      total: 1,
      overduePaise: 100_00,
      rows: [
        {
          partyId: PARTY.id,
          name: 'Apex Builders',
          phone: null,
          salesperson: null,
          outstandingPaise: 100_00,
          overduePaise: 100_00,
          maxDaysPastDue: 5,
          oldestBucket: 'days_0_30',
          lastActivity: null,
          openPromise: null,
          openEscalationId: null,
          nextStep: 'contact',
        },
      ],
    };
    const { user } = renderApp({
      path: '/collections',
      routes: partyRoutes({
        'GET /auth/me': () => json(SALES),
        'GET /collections/worklist': () => json(worklist),
      }),
    });
    await user.click(
      await screen.findByRole('button', { name: 'Send a payment link to Apex Builders' }),
    );
    expect(await screen.findByRole('dialog', { name: 'Send a UPI payment link' })).toBeVisible();
  });
});

describe('PaymentLinksPage', { timeout: 30_000 }, () => {
  it('lists links newest first, by status, page by page', async () => {
    const { user, requests } = renderApp({
      path: '/payment-links',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /payment-links/settings': () => json(ON),
        'GET /payment-links': (request) =>
          request.query.get('status') === 'paid'
            ? json(PAGE([]))
            : json(
                PAGE(
                  [
                    SUMMARY({ purpose: 'bills', origin: 'reminder', paidPaise: 500_00 }),
                    SUMMARY({ id: 'link-2', number: 'PL-000002', status: 'cancelled' }),
                  ],
                  30,
                ),
              ),
      },
    });
    const table = await screen.findByRole('table', { name: 'Payment links' });
    const [, first, second] = within(table).getAllByRole('row');
    expect(first).toHaveTextContent('PL-000001');
    expect(first).toHaveTextContent('Reminded bills');
    expect(first).toHaveTextContent('Part paid');
    expect(within(found(first)).getByRole('link', { name: 'Apex Builders' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}`,
    );
    expect(second).toHaveTextContent('Cancelled');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(
        requests
          .filter((request) => request.path === '/payment-links')
          .at(-1)
          ?.query.get('offset'),
      ).toBe('25');
    });
    await user.selectOptions(screen.getByLabelText('Status'), 'paid');
    expect(await screen.findByText('No payment link has been sent yet.')).toBeVisible();
    expect(
      requests
        .filter((request) => request.path === '/payment-links')
        .at(-1)
        ?.query.get('status'),
    ).toBe('paid');
  });
});

describe('LogCheckoutPage (the log provider’s test payment page)', { timeout: 30_000 }, () => {
  const CHECKOUT: LogCheckoutView = {
    reference: 'plink_log_aaaaaaaaaaaaaaaaaaaaaa',
    business: 'ABC Paints',
    partyName: 'Apex Builders',
    number: 'PL-000001',
    description: 'ABC Paints: Invoice AMP/26-27/000001',
    amountPaise: 1_180_00,
    paidPaise: 180_00,
    status: 'created',
    expiresAt: '2026-10-23T05:00:00.000Z',
  };
  const WEBHOOK: LogWebhook = {
    path: '/webhooks/payment-links/log',
    header: 'x-log-gateway-signature',
    signature: 'abc123',
    body: '{"id":"evt_log_1","type":"payment.captured"}',
  };
  const path = `/pay/${CHECKOUT.reference}`;

  it('pays the rest, posts the signed webhook as a gateway would, and posts it again', async () => {
    let deliveries = 0;
    const { user, requests } = renderApp({
      path,
      session: null,
      routes: {
        'GET /public/payment-links/log/:reference': () => json(CHECKOUT),
        'POST /public/payment-links/log/:reference/pay': () => json(WEBHOOK),
        'POST /webhooks/payment-links/log': () => {
          deliveries += 1;
          return json({ received: deliveries === 1 ? 'applied' : 'duplicate' });
        },
      },
    });
    expect(await screen.findByText('ABC Paints: Invoice AMP/26-27/000001')).toBeVisible();
    expect(screen.getByText('Open')).toBeVisible();
    expect(screen.getByLabelText('Amount to pay (₹)')).toHaveValue('1000.00');
    await user.click(screen.getByRole('button', { name: 'Pay by UPI (test)' }));
    expect(await screen.findByText('Paid: the payment is recorded and allocated.')).toBeVisible();
    expect(requests.find((request) => request.path.endsWith('/pay'))?.body).toEqual({
      amountPaise: 1_000_00,
    });
    const delivered = requests.find((request) => request.path === WEBHOOK.path);
    expect(delivered?.body).toEqual(JSON.parse(WEBHOOK.body));
    expect(delivered?.headers['x-log-gateway-signature']).toBe('abc123');

    await user.click(screen.getByRole('button', { name: 'Send the same payment again' }));
    expect(
      await screen.findByText('Sent again: it was already recorded, so nothing changed.'),
    ).toBeVisible();
  });

  it('offers the whole amount once paid, checks it, and says when nothing was recorded', async () => {
    const { user } = renderApp({
      path,
      session: null,
      routes: {
        'GET /public/payment-links/log/:reference': () =>
          json({ ...CHECKOUT, paidPaise: 1_180_00, status: 'paid' }),
        'POST /public/payment-links/log/:reference/pay': () => json(WEBHOOK),
        'POST /webhooks/payment-links/log': () => json({ received: 'ignored' }),
      },
    });
    const amount = await screen.findByLabelText('Amount to pay (₹)');
    expect(amount).toHaveValue('1180.00');
    await user.clear(amount);
    await user.type(amount, 'x');
    await user.click(screen.getByRole('button', { name: 'Pay by UPI (test)' }));
    expect(await screen.findByText('Enter an amount above zero')).toBeVisible();
    await user.clear(amount);
    await user.type(amount, '10');
    await user.click(screen.getByRole('button', { name: 'Pay by UPI (test)' }));
    expect(await screen.findByText('Received, but nothing was recorded.')).toBeVisible();
  });

  it('shows why a payment failed, and a link that does not exist', async () => {
    const { user } = renderApp({
      path,
      session: null,
      routes: {
        'GET /public/payment-links/log/:reference': () => json(CHECKOUT),
        'POST /public/payment-links/log/:reference/pay': () =>
          json({ statusCode: 400, message: 'Invalid signature' }, 400),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Pay by UPI (test)' }));
    expect(await screen.findByText('Invalid signature')).toBeVisible();
  });

  it('says when the link is unknown', async () => {
    renderApp({ path, session: null, routes: {} });
    expect(await screen.findByText('This payment link does not exist.')).toBeVisible();
  });
});

describe('UPI link money at the day end and in payments', { timeout: 30_000 }, () => {
  it('points the day end to the payments by UPI link, filtered by mode', async () => {
    const { user, requests } = renderApp({
      path: '/payments',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /payment-links/settings': () => json(ON),
        'GET /payments': () => json({ items: [], total: 0, nextCursor: null }),
      },
    });
    await user.selectOptions(await screen.findByLabelText('Mode'), 'upi_link');
    // The page's own link, and the tab in Money.
    expect(
      screen
        .getAllByRole('link', { name: 'Payment links' })
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/payment-links', '/payment-links']);
    await waitFor(() => {
      expect(
        requests
          .filter((request) => request.path === '/payments')
          .at(-1)
          ?.query.get('modeKind'),
      ).toBe('upi_link');
    });
  });

  it('tells the day end that link payments go to no register', async () => {
    renderApp({
      path: '/registers',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /stores': () => json(STORES),
        'GET /register-sessions': () => json({ items: [], total: 0, nextCursor: null }),
        'GET /payment-links/settings': () => json(ON),
      },
    });
    expect(await screen.findByText(/Money paid by UPI link goes to no register/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Payments by UPI link' })).toHaveAttribute(
      'href',
      '/payments?modeKind=upi_link',
    );
  });
});

describe('statement shares with a payment link', { timeout: 30_000 }, () => {
  const DATA: StatementData = {
    business: { name: 'ABC Paints', legalName: null, gstin: null, address: null },
    party: { id: PARTY.id, name: 'Apex Builders', phone: null, gstin: null, address: null },
    from: '2026-04-01',
    to: '2026-10-11',
    generatedOn: '2026-10-11',
    openingPaise: 0,
    entries: [],
    debitsPaise: 0,
    creditsPaise: 0,
    closingPaise: 680_00,
    ageing: { ...emptyTotals(), outstandingPaise: 680_00, netPaise: 680_00 },
    openItems: [],
  };
  const SHARED: StatementShareResult = {
    link: {
      id: 'statement-link-1',
      from: '2026-04-01',
      to: '2026-10-11',
      language: 'en',
      status: 'active',
      expiresAt: '2026-10-18T05:00:00.000Z',
      revokedAt: null,
      openedCount: 0,
      lastOpenedAt: null,
      createdBy: 'Anil Kumar',
      createdAt: '2026-10-11T05:00:00.000Z',
    },
    url: 'https://app.example.in/api/public/statements/abc',
    waMeUrl: null,
    message: { queued: false, reason: 'no_consent' },
    paymentLink: {
      number: 'PL-000009',
      url: 'https://app.example.in/pay/plink_log_x',
      amountPaise: 680_00,
    },
  };

  it('shows the UPI link and carries it in the wa.me text', async () => {
    const { user } = renderApp({
      path: `/parties/${PARTY.id}/statement?from=2026-04-01&to=2026-10-11`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /parties/:id/statement': () => json(DATA),
        'GET /messaging/status': () => json({ whatsapp: 'log', sms: false, email: false }),
        'GET /parties/:id/statement/links': () => json([]),
        'POST /parties/:id/statement/links': () => json(SHARED, 201),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Send on WhatsApp' }));
    expect(
      await screen.findByText('UPI payment link: https://app.example.in/pay/plink_log_x'),
    ).toBeVisible();
    const open = screen.getByRole('link', { name: 'Open WhatsApp with the link' });
    expect(decodeURIComponent(String(open.getAttribute('href')))).toContain(
      'Pay by UPI: https://app.example.in/pay/plink_log_x',
    );
  });
});
