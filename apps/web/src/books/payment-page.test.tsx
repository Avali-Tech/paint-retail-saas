import type { PaymentView } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { paymentActions } from './PaymentPage.js';
import { ALL_MODES, ALLOCATION, OPEN_LEDGER, PAYMENT_VIEW } from './test-support/books-fixtures.js';

const location = () => screen.getByTestId('location').textContent;
const click = vi.fn<(this: HTMLAnchorElement) => void>();

beforeEach(() => {
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:receipt'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record(
    this: HTMLAnchorElement,
  ) {
    click.call(this);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  click.mockClear();
});

/** A payment the API answers with, changed by each action as the API would. */
function payments(start: PaymentView, extra: Record<string, FakeHandler> = {}) {
  let current = start;
  const answer = (next: Partial<PaymentView>) => {
    current = { ...current, ...next };
    return json(current);
  };
  return {
    'GET /auth/me': () => json(OWNER),
    'GET /payment-modes': () => json(ALL_MODES),
    'GET /payments/:id': () => json(current),
    'GET /parties/:id/ledger': () => json(OPEN_LEDGER()),
    'POST /payments/:id/allocations/:allocationId/reverse': () =>
      answer({
        unallocatedPaise: current.unallocatedPaise + 50_000,
        allocations: [
          ALLOCATION({ reversed: true }),
          ALLOCATION({
            id: 'alloc-2',
            amountPaise: -50_000,
            reversesAllocationId: 'alloc-1',
            reversalReason: 'undone',
          }),
        ],
      }),
    'POST /payments/:id/allocate': () =>
      answer({
        unallocatedPaise: 0,
        allocations: [
          ...current.allocations,
          ALLOCATION({
            id: 'alloc-3',
            partyLedgerId: 'led-1',
            documentId: null,
            targetNumber: 'Opening balance',
          }),
        ],
      }),
    'POST /payments/:id/clear': () =>
      answer({ chequeStatus: 'cleared', chequeClearedOn: '2026-10-09' }),
    'POST /payments/:id/bounce': () =>
      answer({
        chequeStatus: 'bounced',
        chequeBouncedOn: '2026-10-10',
        bounceReason: 'Funds insufficient',
        unallocatedPaise: 0,
      }),
    ...extra,
  };
}

describe('paymentActions', () => {
  it('offers what the API allows', () => {
    expect(paymentActions(PAYMENT_VIEW())).toEqual({ allocate: true, cheque: true, refund: false });
    expect(paymentActions(PAYMENT_VIEW({ chequeStatus: 'cleared' }))).toEqual({
      allocate: true,
      cheque: false,
      refund: true,
    });
    expect(paymentActions(PAYMENT_VIEW({ chequeStatus: 'bounced' }))).toEqual({
      allocate: false,
      cheque: false,
      refund: false,
    });
    expect(
      paymentActions(PAYMENT_VIEW({ direction: 'out', chequeStatus: null, unallocatedPaise: 0 })),
    ).toEqual({ allocate: false, cheque: false, refund: false });
  });
});

describe('PaymentPage', { timeout: 30_000 }, () => {
  it('undoes an allocation, puts the advance against bills and clears the cheque', async () => {
    const { user, requests } = renderApp({
      path: '/payments/pay-1',
      routes: payments(PAYMENT_VIEW({ note: 'Site 4', voucherNumber: 'AMPRV/26-27/0001' })),
    });
    expect(
      await screen.findByRole('heading', { name: 'Payment RC-000012', level: 1 }),
    ).toBeVisible();
    const details = screen.getByRole('region', { name: 'Details' });
    expect(details).toHaveTextContent('Cheque pending');
    expect(details).toHaveTextContent('Voucher');
    expect(details).toHaveTextContent('AMPRV/26-27/0001');
    expect(details).toHaveTextContent('Reference004512');
    expect(details).toHaveTextContent('Not against any bill (advance)₹500.00');
    expect(details).toHaveTextContent('NoteSite 4');
    expect(screen.getByText(/This cheque is with the bank/)).toBeVisible();
    // A pending cheque is refunded only after it clears.
    expect(screen.queryByRole('button', { name: 'Refund advance' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Customer account' })).toHaveAttribute(
      'href',
      '/parties/party-1/ledger',
    );

    const paid = screen.getByRole('table', { name: 'Bills paid' });
    expect(within(paid).getByRole('link', { name: 'AMP/26-27/000001' })).toHaveAttribute(
      'href',
      '/invoices/inv-1',
    );
    await user.click(within(paid).getByRole('button', { name: 'Undo against AMP/26-27/000001' }));
    const undo = await screen.findByRole('dialog', {
      name: 'Undo ₹500.00 against AMP/26-27/000001?',
    });
    await user.click(within(undo).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Payment updated')).toBeVisible();
    expect(requests.find((request) => request.path.endsWith('/reverse'))?.path).toBe(
      '/payments/pay-1/allocations/alloc-1/reverse',
    );
    await waitFor(() => {
      expect(within(paid).getAllByText('Undone')).toHaveLength(1);
    });
    expect(within(paid).getByText('Undoes an earlier one')).toBeVisible();
    expect(within(paid).queryByRole('button', { name: /Undo against/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Put against bills' }));
    const allocate = await screen.findByRole('dialog', { name: 'Put RC-000012 against bills' });
    expect(within(allocate).getByText('₹1,000.00 is not against any bill yet.')).toBeVisible();
    const amount = (bill: string) =>
      within(allocate).getByRole('textbox', { name: `Amount against ${bill}` });
    expect(amount('Opening balance')).toHaveValue('200.00');
    await user.click(within(allocate).getByRole('button', { name: 'Clear all' }));
    await user.click(within(allocate).getByRole('button', { name: 'Put against bills' }));
    expect(
      await within(allocate).findByText('Enter an amount against at least one bill'),
    ).toBeVisible();
    await user.type(amount('AMP/26-27/000002'), 'abc');
    await user.click(within(allocate).getByRole('button', { name: 'Put against bills' }));
    expect(within(allocate).getByText('Enter an amount in rupees')).toBeVisible();
    await user.clear(amount('AMP/26-27/000002'));
    await user.type(amount('Opening balance'), '200');
    await user.click(within(allocate).getByRole('button', { name: 'Put against bills' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(requests.find((request) => request.path.endsWith('/allocate'))?.body).toEqual({
      allocations: [{ partyLedgerId: 'led-1', amountPaise: 20_000 }],
    });

    await user.click(screen.getByRole('button', { name: 'Cheque cleared' }));
    const clear = await screen.findByRole('dialog', { name: 'Cheque 004512 cleared' });
    await user.clear(within(clear).getByLabelText('Cleared on'));
    await user.click(within(clear).getByRole('button', { name: 'Cheque cleared' }));
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Details' })).toHaveTextContent('Cheque cleared');
    });
    expect(requests.find((request) => request.path.endsWith('/clear'))?.body).toEqual({});
    expect(screen.queryByRole('button', { name: 'Cheque bounced' })).toBeNull();
  });

  it('bounces a cheque with the bank’s reason and a charge', async () => {
    const { user, requests } = renderApp({
      path: '/payments/pay-1',
      routes: payments(PAYMENT_VIEW()),
    });
    await user.click(await screen.findByRole('button', { name: 'Cheque bounced' }));
    const bounce = await screen.findByRole('dialog', { name: 'Cheque 004512 bounced' });
    expect(
      within(bounce).getByText(/The bills it paid are owed again, and ₹1,000.00 is added back/),
    ).toBeVisible();
    await user.type(within(bounce).getByRole('textbox', { name: /Bounce charge/ }), '0');
    await user.click(within(bounce).getByRole('button', { name: 'Cheque bounced' }));
    expect(within(bounce).getByText('Say why the bank returned it')).toBeVisible();
    expect(within(bounce).getByText('Enter an amount above zero, or leave it empty')).toBeVisible();
    await user.type(within(bounce).getByRole('textbox', { name: /Reason/ }), 'Funds insufficient');
    const bouncedOn = within(bounce).getByLabelText('Bounced on');
    await user.clear(bouncedOn);
    await user.type(bouncedOn, '2026-10-10');
    const charge = within(bounce).getByRole('textbox', { name: /Bounce charge/ });
    await user.clear(charge);
    await user.type(charge, '150');
    await user.click(within(bounce).getByRole('button', { name: 'Cheque bounced' }));
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Details' })).toHaveTextContent(
        'Bounced on10 Oct 2026 · Funds insufficient',
      );
    });
    expect(requests.find((request) => request.path.endsWith('/bounce'))?.body).toMatchObject({
      bouncedOn: '2026-10-10',
      reason: 'Funds insufficient',
      chargePaise: 15_000,
    });
    // A bounced cheque allows nothing more.
    expect(screen.queryByRole('button', { name: 'Put against bills' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull();
  });

  it('bounces without a charge, and shows the API’s refusal', async () => {
    const { user, requests } = renderApp({
      path: '/payments/pay-1',
      routes: payments(PAYMENT_VIEW(), {
        'POST /payments/:id/bounce': (request) =>
          (request.body as { reason: string }).reason === 'Late'
            ? json(
                {
                  statusCode: 422,
                  message: 'Cannot record the payment',
                  issues: [{ path: 'bouncedOn', message: 'This date is in the future' }],
                },
                422,
              )
            : json(
                PAYMENT_VIEW({
                  chequeStatus: 'bounced',
                  chequeBouncedOn: '2026-10-10',
                  bounceReason: 'Signature',
                }),
              ),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Cheque bounced' }));
    const bounce = await screen.findByRole('dialog', { name: 'Cheque 004512 bounced' });
    await user.type(within(bounce).getByRole('textbox', { name: /Reason/ }), 'Late');
    await user.click(within(bounce).getByRole('button', { name: 'Cheque bounced' }));
    expect(
      await within(bounce).findByText('Cannot record the payment: This date is in the future'),
    ).toBeVisible();
    const reason = within(bounce).getByRole('textbox', { name: /Reason/ });
    await user.clear(reason);
    await user.type(reason, 'Signature');
    await user.click(within(bounce).getByRole('button', { name: 'Cheque bounced' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(
      requests.filter((request) => request.path.endsWith('/bounce')).at(-1)?.body,
    ).not.toHaveProperty('chargePaise');
  });

  it('refunds an advance by the way it came, then opens the refund', async () => {
    const refund = PAYMENT_VIEW({
      id: 'ref-1',
      number: 'RF-000001',
      direction: 'out',
      mode: { id: 'mode-cash', kind: 'cash', name: 'Cash' },
      chequeStatus: null,
      reference: null,
      chequeDate: null,
      unallocatedPaise: 0,
      allocations: [],
    });
    const { user, requests } = renderApp({
      path: '/payments/pay-1',
      routes: {
        ...payments(
          PAYMENT_VIEW({
            mode: { id: 'mode-bank', kind: 'bank_transfer', name: 'Bank transfer' },
            chequeStatus: null,
            reference: null,
            chequeDate: null,
            allocations: [
              ALLOCATION({
                id: 'alloc-r',
                refundPaymentId: 'ref-0',
                documentId: null,
                targetNumber: 'RF-000000',
              }),
              ALLOCATION({ id: 'alloc-b', reversed: true }),
              ALLOCATION({
                id: 'alloc-c',
                amountPaise: -50_000,
                reversesAllocationId: 'alloc-b',
                reversalReason: 'cheque_bounce',
                targetNumber: null,
                documentId: null,
              }),
            ],
          }),
        ),
        'GET /payments/:id': (request) =>
          json(
            request.path.endsWith('ref-1')
              ? refund
              : PAYMENT_VIEW({
                  mode: { id: 'mode-bank', kind: 'bank_transfer', name: 'Bank transfer' },
                  chequeStatus: null,
                  reference: null,
                  chequeDate: null,
                  allocations: [
                    ALLOCATION({
                      id: 'alloc-r',
                      refundPaymentId: 'ref-0',
                      documentId: null,
                      targetNumber: 'RF-000000',
                    }),
                    ALLOCATION({ id: 'alloc-b', reversed: true }),
                    ALLOCATION({
                      id: 'alloc-c',
                      amountPaise: -50_000,
                      reversesAllocationId: 'alloc-b',
                      reversalReason: 'cheque_bounce',
                      targetNumber: null,
                      documentId: null,
                    }),
                  ],
                }),
          ),
        'POST /payments/:id/refund': () => json(refund),
      },
    });
    const paid = await screen.findByRole('table', { name: 'Bills paid' });
    expect(within(paid).getByText('Paid back')).toBeVisible();
    expect(within(paid).getByText('Cheque bounced')).toBeVisible();
    expect(within(paid).getByText('Undone')).toBeVisible();
    expect(within(paid).queryByRole('button', { name: /Undo against/ })).toBeNull();

    await user.click(await screen.findByRole('button', { name: 'Refund advance' }));
    const dialog = await screen.findByRole('dialog', { name: 'Refund from RC-000012' });
    const mode = within(dialog).getByRole('combobox', { name: 'Paid by' });
    expect(mode).toHaveValue('mode-bank');
    const amount = within(dialog).getByRole('textbox', { name: /Amount to refund/ });
    expect(amount).toHaveValue('500.00');
    await user.clear(amount);
    await user.type(amount, '600');
    await user.click(within(dialog).getByRole('button', { name: 'Refund advance' }));
    expect(
      within(dialog).getByText('Enter an amount above zero, up to what is not against any bill'),
    ).toBeVisible();
    await user.clear(amount);
    await user.type(amount, '300');
    await user.selectOptions(mode, 'mode-cash');
    const paidOn = within(dialog).getByLabelText('Paid on');
    await user.clear(paidOn);
    await user.type(paidOn, '2026-10-09');
    await user.type(within(dialog).getByRole('textbox', { name: /Reference/ }), 'Counter');
    await user.type(within(dialog).getByRole('textbox', { name: 'Note' }), 'Order cancelled');
    await user.click(within(dialog).getByRole('button', { name: 'Refund advance' }));
    await waitFor(() => {
      expect(location()).toBe('/payments/ref-1');
    });
    const posted = requests.find((request) => request.path.endsWith('/refund'));
    expect(posted?.body).toMatchObject({
      modeId: 'mode-cash',
      amountPaise: 30_000,
      paidOn: '2026-10-09',
      reference: 'Counter',
      note: 'Order cancelled',
    });
    expect(posted?.headers['Idempotency-Key']).toEqual(expect.any(String));
    expect(
      await screen.findByRole('heading', { name: 'Refund RF-000001', level: 1 }),
    ).toBeVisible();
    expect(screen.getByText('Refund RF-000001 recorded')).toBeVisible();
    expect(screen.getByText('Not put against any bill yet.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Refund advance' })).toBeNull();
  });

  it('refunds a payment-link payment by the first way to pay, and shows a refusal', async () => {
    const { user } = renderApp({
      path: '/payments/pay-1',
      routes: payments(
        PAYMENT_VIEW({
          mode: { id: 'mode-link', kind: 'upi_link', name: 'UPI link' },
          chequeStatus: null,
          allocations: [],
        }),
        {
          'POST /payments/:id/refund': () =>
            json(
              { statusCode: 409, message: 'Open the register at this store before taking cash' },
              409,
            ),
        },
      ),
    });
    await user.click(await screen.findByRole('button', { name: 'Refund advance' }));
    const dialog = await screen.findByRole('dialog', { name: 'Refund from RC-000012' });
    expect(within(dialog).getByRole('combobox', { name: 'Paid by' })).toHaveValue('mode-cash');
    await user.click(within(dialog).getByRole('button', { name: 'Refund advance' }));
    expect(
      await within(dialog).findByText('Open the register at this store before taking cash'),
    ).toBeVisible();
  });

  it('downloads the receipt, and shows a failed download', async () => {
    let fail = false;
    const { user } = renderApp({
      path: '/payments/pay-1',
      routes: payments(PAYMENT_VIEW(), {
        'GET /payments/:id/receipt.pdf': () =>
          fail
            ? json({ statusCode: 500, message: 'Printer down' }, 500)
            : { status: 200, raw: '%PDF-1.7' },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Receipt PDF' }));
    await waitFor(() => {
      expect(click).toHaveBeenCalledOnce();
    });
    expect(click.mock.contexts[0]?.download).toBe('RC-000012.pdf');
    fail = true;
    await user.click(screen.getByRole('button', { name: 'Receipt PDF' }));
    expect(await screen.findByText('Printer down')).toBeVisible();
  });

  it('shows a reader the payment without any action', async () => {
    renderApp({
      path: '/payments/pay-1',
      routes: {
        ...payments(PAYMENT_VIEW({ allocations: [] })),
        'GET /auth/me': () => json(profile(['sales:read'])),
      },
    });
    expect(await screen.findByText('Not put against any bill yet.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Put against bills' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cheque cleared' })).toBeNull();
  });

  it('hides the refund when no way to pay is switched on, and shows a failure to load', async () => {
    const { unmount } = renderApp({
      path: '/payments/pay-1',
      routes: {
        ...payments(PAYMENT_VIEW({ chequeStatus: 'cleared', chequeClearedOn: '2026-10-09' })),
        'GET /payment-modes': () => json([]),
      },
    });
    expect(await screen.findByRole('button', { name: 'Put against bills' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Details' })).toHaveTextContent(
      'Cleared on9 Oct 2026',
    );
    expect(screen.queryByRole('button', { name: 'Refund advance' })).toBeNull();
    unmount();

    renderApp({
      path: '/payments/pay-1',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /payments/:id': () => json({ message: 'Down' }, 500),
      },
    });
    expect(await screen.findByText('Could not load the payment')).toBeVisible();
  });

  it('clears a cheque on today’s date unless another is chosen', async () => {
    const { user, requests } = renderApp({
      path: '/payments/pay-1',
      routes: payments(PAYMENT_VIEW()),
    });
    await user.click(await screen.findByRole('button', { name: 'Cheque cleared' }));
    const clear = await screen.findByRole('dialog', { name: 'Cheque 004512 cleared' });
    await user.click(within(clear).getByRole('button', { name: 'Cheque cleared' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(requests.find((request) => request.path.endsWith('/clear'))?.body).toEqual({
      clearedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it('shows an allocation the API refused', async () => {
    const { user } = renderApp({
      path: '/payments/pay-1',
      routes: payments(PAYMENT_VIEW(), {
        'POST /payments/:id/allocate': () =>
          json({ statusCode: 409, message: 'This payment is already fully allocated' }, 409),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Put against bills' }));
    const allocate = await screen.findByRole('dialog', { name: 'Put RC-000012 against bills' });
    await user.click(within(allocate).getByRole('button', { name: 'Put against bills' }));
    expect(
      await within(allocate).findByText('This payment is already fully allocated'),
    ).toBeVisible();
  });
});
