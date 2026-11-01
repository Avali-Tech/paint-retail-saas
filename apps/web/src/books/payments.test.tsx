import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { PAYMENTS_PAGE_SIZE } from './PaymentsPage.js';
import { PAYMENT } from './test-support/books-fixtures.js';

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

describe('PaymentsPage', { timeout: 30_000 }, () => {
  it('lists payments with filters and downloads each receipt as a PDF', async () => {
    const { user, requests } = renderApp({
      path: '/payments',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /payments': (request) =>
          request.query.get('offset') === '0'
            ? json({
                items: [
                  PAYMENT(),
                  PAYMENT({
                    id: 'pay-2',
                    number: 'RC-000013',
                    voucherNumber: 'AMPRV/26-27/0001',
                    modeKind: 'cheque',
                    modeName: 'Cheque',
                    chequeStatus: 'bounced',
                  }),
                  PAYMENT({
                    id: 'pay-3',
                    number: 'RF-000002',
                    direction: 'out',
                    chequeStatus: 'pending',
                  }),
                ],
                total: PAYMENTS_PAGE_SIZE + 1,
                totalCapped: false,
                nextCursor: 'cursor-2',
              })
            : json({ items: [], total: 0, totalCapped: false, nextCursor: null }),
        'GET /payments/:id/receipt.pdf': (request) =>
          request.path.includes('pay-1')
            ? {
                status: 200,
                raw: '%PDF-1.7',
                headers: { 'content-disposition': 'attachment; filename="RC-000012.pdf"' },
              }
            : request.path.includes('pay-2')
              ? { status: 200, raw: '%PDF-1.7' }
              : json({ statusCode: 404, message: 'Payment not found' }, 404),
      },
    });
    const table = await screen.findByRole('table', { name: 'Payments' });
    expect(requests.at(-1)?.query.toString()).toBe('limit=50&offset=0');
    expect(screen.getByRole('link', { name: 'Take a payment' })).toHaveAttribute(
      'href',
      '/payments/new',
    );
    expect(within(table).getByRole('link', { name: 'RC-000012' })).toHaveAttribute(
      'href',
      '/payments/pay-1',
    );
    const [, received, voucher, refund] = within(table).getAllByRole('row');
    expect(received).toHaveTextContent('RC-000012Received');
    expect(received).toHaveTextContent('Deccan Contractors');
    expect(received).toHaveTextContent('₹1,500.00');
    expect(voucher).toHaveTextContent('RC-000013AMPRV/26-27/0001');
    expect(voucher).toHaveTextContent('ChequeBounced');
    expect(refund).toHaveTextContent('RF-000002Refunded');
    expect(refund).toHaveTextContent('Cheque pending');

    await user.click(screen.getByRole('button', { name: 'Receipt PDF RC-000012' }));
    await waitFor(() => {
      expect(click).toHaveBeenCalledOnce();
    });
    expect(click.mock.contexts[0]?.download).toBe('RC-000012.pdf');
    await user.click(screen.getByRole('button', { name: 'Receipt PDF RC-000013' }));
    await waitFor(() => {
      expect(click).toHaveBeenCalledTimes(2);
    });
    expect(click.mock.contexts[1]?.download).toBe('RC-000013.pdf');
    await user.click(screen.getByRole('button', { name: 'Receipt PDF RF-000002' }));
    expect(await screen.findByText('Payment not found')).toBeVisible();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Direction' }), 'out');
    await user.type(screen.getByLabelText('From'), '2026-10-01');
    await user.type(screen.getByLabelText('To'), '2026-10-08');
    await user.type(screen.getByRole('searchbox', { name: 'Receipt or reference number' }), 'RC');
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('q')).toBe('RC');
    });
    expect(requests.at(-1)?.query.toString()).toBe(
      'direction=out&from=2026-10-01&to=2026-10-08&q=RC&limit=50&offset=0',
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('cursor')).toBe('cursor-2');
      expect(requests.at(-1)?.query.get('offset')).toBe('50');
    });
    expect(await screen.findByText('No payments here')).toBeVisible();
  });

  it('shows a failure, and no way to take a payment to a reader', async () => {
    renderApp({
      path: '/payments',
      routes: {
        'GET /auth/me': () => json(profile(['sales:read'])),
        'GET /payments': () => json({ message: 'Down' }, 500),
      },
    });
    expect(await screen.findByText('Could not load the payments')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Take a payment' })).toBeNull();
  });
});
