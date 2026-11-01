import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import { PARTY } from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { ALL_MODES, AMP, KKP, OPEN_LEDGER, PAYMENT_VIEW } from './test-support/books-fixtures.js';

const location = () => screen.getByTestId('location').textContent;
const field = (name: string) => screen.getByRole('textbox', { name });

/** A member who takes payments but does not run the register. */
const COLLECTOR = profile(['payments:manage', 'sales:read', 'parties:read', 'stores:read'], {
  role: { key: 'sales_executive', name: 'Sales Executive' },
});

const routes = () => ({
  'GET /auth/me': () => json(OWNER),
  'GET /stores': () => json([AMP, KKP]),
  'GET /payment-modes': () => json(ALL_MODES),
  'GET /parties': () => json({ items: [PARTY], total: 1 }),
  'GET /parties/:id': () => json(PARTY),
  'GET /parties/:id/ledger': () => json(OPEN_LEDGER()),
});

describe('TakePaymentPage', { timeout: 30_000 }, () => {
  it('takes a cheque on account, against the oldest bills first or as typed', async () => {
    const { user, requests } = renderApp({
      path: '/payments/new',
      routes: {
        ...routes(),
        'POST /payments': (request) =>
          (request.body as { reference?: string }).reference === 'BAD'
            ? json(
                {
                  statusCode: 422,
                  message: 'Cannot record the payment',
                  issues: [{ path: 'chequeDate', message: 'This date is in the future' }],
                },
                422,
              )
            : json(PAYMENT_VIEW({ id: 'pay-new', number: 'RC-000013' })),
        'GET /payments/:id': () => json(PAYMENT_VIEW({ id: 'pay-new', number: 'RC-000013' })),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Take a payment', level: 1 })).toBeVisible();
    await user.type(screen.getByRole('searchbox', { name: /Search/ }), 'Apex');
    await user.click(await screen.findByRole('button', { name: 'Choose Apex Builders' }));
    await waitFor(() => {
      expect(location()).toBe(`/payments/new?partyId=${PARTY.id}`);
    });
    expect(await screen.findByRole('link', { name: 'Apex Builders' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}/ledger`,
    );
    const mode = await screen.findByRole('combobox', { name: /Paid by/ });
    // Only the ways a member takes money by hand: no switched-off mode, no payment link.
    expect(
      within(mode)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Cash', 'Bank transfer', 'Cheque']);
    const bills = await screen.findByRole('table', { name: 'Bills due' });
    expect(within(bills).getAllByRole('row')[1]).toHaveTextContent(
      'Opening balanceOpening balance · 1 Apr 2026—₹200.00',
    );
    expect(screen.getByText('Cash goes into the open register at this store.')).toBeVisible();

    // Nothing typed: the store and the amount are asked for.
    await user.click(screen.getByRole('button', { name: 'Take payment' }));
    expect(screen.getByText('Choose the store the money came to')).toBeVisible();
    expect(screen.getByText('Enter an amount above zero, such as 1500')).toBeVisible();

    await user.selectOptions(screen.getByRole('combobox', { name: /Store/ }), KKP.id);
    await user.selectOptions(mode, 'mode-cheque');
    expect(screen.getByRole('textbox', { name: /Cheque number/ })).toBeVisible();
    await user.type(field('Amount (₹)'), '1000');
    const amount = (bill: string) =>
      within(bills).getByRole('textbox', { name: `Amount against ${bill}` });
    expect(amount('Opening balance')).toHaveValue('200.00');
    expect(amount('AMP/26-27/000001')).toHaveValue('500.00');
    expect(amount('AMP/26-27/000002')).toHaveValue('300.00');
    expect(screen.getByLabelText('How the money is used')).toHaveTextContent(
      'Against bills₹1,000.00Stays as advance₹0.00',
    );

    // Typed by hand: the opening balance waits, ₹200 stays as an advance.
    await user.clear(amount('Opening balance'));
    expect(screen.getByLabelText('How the money is used')).toHaveTextContent(
      'Against bills₹800.00Stays as advance₹200.00',
    );
    await user.clear(amount('AMP/26-27/000002'));
    await user.type(amount('AMP/26-27/000002'), '900');
    expect(screen.getByText('At most ₹800.00')).toBeVisible();
    await user.clear(amount('AMP/26-27/000002'));
    await user.type(amount('AMP/26-27/000002'), '600');
    expect(screen.getByText('That is ₹100.00 more than the money there is.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Take ₹1,000.00' }));
    expect(screen.getByText('Enter the cheque number')).toBeVisible();
    expect(screen.getByText('Enter the date written on the cheque')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Fill oldest first' }));
    expect(amount('Opening balance')).toHaveValue('200.00');
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(amount('Opening balance')).toHaveValue('');
    await user.type(amount('AMP/26-27/000001'), '500');

    const received = screen.getByLabelText(/Received on/);
    await user.clear(received);
    await user.type(received, '2099-01-01');
    await user.type(screen.getByRole('textbox', { name: /Cheque number/ }), 'BAD');
    await user.type(screen.getByLabelText(/Date on the cheque/), '2026-10-07');
    await user.click(screen.getByRole('button', { name: 'Take ₹1,000.00' }));
    expect(screen.getByText('Enter a date that is not in the future')).toBeVisible();
    await user.clear(received);
    await user.type(received, '2026-10-08');
    await user.click(screen.getByRole('button', { name: 'Take ₹1,000.00' }));
    expect(
      await screen.findByText('Cannot record the payment: This date is in the future'),
    ).toBeVisible();
    // Not cash: no way to the register.
    expect(screen.queryByRole('link', { name: 'Open the register' })).toBeNull();

    const reference = screen.getByRole('textbox', { name: /Cheque number/ });
    await user.clear(reference);
    await user.type(reference, '004513');
    await user.type(screen.getByRole('textbox', { name: 'Note' }), 'Part payment');
    await user.click(screen.getByRole('button', { name: 'Take ₹1,000.00' }));
    await waitFor(() => {
      expect(location()).toBe('/payments/pay-new');
    });
    const posted = requests.filter((request) => request.method === 'POST');
    expect(posted.at(-1)?.body).toEqual({
      storeId: KKP.id,
      partyId: PARTY.id,
      modeId: 'mode-cheque',
      amountPaise: 1_00_000,
      receivedOn: '2026-10-08',
      reference: '004513',
      chequeDate: '2026-10-07',
      note: 'Part payment',
      allocations: [{ documentId: 'inv-1', amountPaise: 50_000 }],
    });
    // The same key both times, so a retried post counts once.
    expect(posted[0]?.headers['Idempotency-Key']).toBe(posted.at(-1)?.headers['Idempotency-Key']);
    expect(await screen.findByText('Payment RC-000013 recorded')).toBeVisible();
  });

  it('takes cash at the only store, and points to the register when none is open', async () => {
    const { user, requests } = renderApp({
      path: `/payments/new?partyId=${PARTY.id}`,
      routes: {
        ...routes(),
        'GET /stores': () => json([AMP]),
        'GET /parties/:id/ledger': () => json(OPEN_LEDGER([])),
        'POST /payments': () =>
          json(
            { statusCode: 409, message: 'Open the register at this store before taking cash' },
            409,
          ),
      },
    });
    expect(
      await screen.findByText('No bills are due: the whole amount stays as an advance.'),
    ).toBeVisible();
    await user.type(field('Amount (₹)'), '250');
    await user.click(screen.getByRole('button', { name: 'Take ₹250.00' }));
    expect(
      await screen.findByText('Open the register at this store before taking cash'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the register' })).toHaveAttribute(
      'href',
      '/registers',
    );
    expect(requests.at(-1)?.body).toMatchObject({
      storeId: AMP.id,
      modeId: 'mode-cash',
      amountPaise: 25_000,
      allocations: [],
    });
    expect(requests.at(-1)?.body).not.toHaveProperty('reference');

    await user.click(screen.getByRole('button', { name: 'Change customer' }));
    await waitFor(() => {
      expect(location()).toBe('/payments/new');
    });
  });

  it('leaves the register link out for a member who does not run it', async () => {
    const { user } = renderApp({
      path: `/payments/new?partyId=${PARTY.id}`,
      routes: {
        ...routes(),
        'GET /auth/me': () => json(COLLECTOR),
        'GET /stores': () => json([AMP]),
        'POST /payments': () =>
          json(
            { statusCode: 409, message: 'Open the register at this store before taking cash' },
            409,
          ),
      },
    });
    await user.type(await screen.findByRole('textbox', { name: 'Amount (₹)' }), '100');
    await user.click(screen.getByRole('button', { name: 'Take ₹100.00' }));
    expect(
      await screen.findByText('Open the register at this store before taking cash'),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Open the register' })).toBeNull();
  });

  it('says when no way to pay is switched on, or the bills cannot be read', async () => {
    renderApp({
      path: `/payments/new?partyId=${PARTY.id}`,
      routes: {
        ...routes(),
        'GET /payment-modes': () => json([ALL_MODES[4]]),
      },
    });
    expect(
      await screen.findByText('No way to pay is switched on. Ask an owner to switch one on.'),
    ).toBeVisible();
  });

  it('shows a failure to read the customer’s bills', async () => {
    renderApp({
      path: `/payments/new?partyId=${PARTY.id}`,
      routes: {
        ...routes(),
        'GET /parties/:id/ledger': () => json({ message: 'Down' }, 500),
      },
    });
    expect(await screen.findByText('Could not load the customer’s bills')).toBeVisible();
  });

  it('is only for members who take payments', async () => {
    renderApp({
      path: '/payments/new',
      routes: { 'GET /auth/me': () => json(profile(['sales:read'])) },
    });
    expect(await screen.findByText('No access')).toBeVisible();
  });
});
