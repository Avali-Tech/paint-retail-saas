import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayInIndia } from '../lib/india-time.js';
import { ISSUED } from '../pos/test-support/pos-fixtures.js';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { ADJUSTMENTS, INVOICE } from '../test-support/sales-fixtures.js';

const print = vi.fn();
const click = vi.fn<(this: HTMLAnchorElement) => void>();

beforeEach(() => {
  vi.spyOn(window, 'print').mockImplementation(print);
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:invoice'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record(
    this: HTMLAnchorElement,
  ) {
    click.call(this);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  print.mockClear();
  click.mockClear();
});

const routes = (overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> => ({
  'GET /auth/me': () => json(OWNER),
  'GET /invoices/:id': () => json(INVOICE),
  'GET /invoices/:id/adjustments': () => json(ADJUSTMENTS),
  'GET /invoices/:id/print': () => json({ ...ISSUED, id: INVOICE.id }),
  ...overrides,
});

describe('Reprinting an invoice', { timeout: 30_000 }, () => {
  it('prints it again on A4 or the counter printer, and downloads the PDF', async () => {
    let pdf: 'named' | 'bare' | 'broken' = 'named';
    const named: Record<string, string> = {
      'content-disposition': 'attachment; filename="AMP-26-27-000001.pdf"',
    };
    const { user, requests } = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: routes({
        'GET /invoices/:id/invoice.pdf': () =>
          pdf === 'broken'
            ? json({ statusCode: 409, message: 'Only an issued invoice is printed' }, 409)
            : { status: 200, raw: '%PDF-1.7', headers: pdf === 'named' ? named : {} },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Print A4' }));
    await waitFor(() => {
      expect(print).toHaveBeenCalledOnce();
    });
    expect(screen.getByTestId('print-layer')).toHaveAttribute('data-format', 'a4');
    expect(screen.getByTestId('print-layer')).toHaveTextContent('AMP/26-27/000001');
    await user.click(screen.getByRole('button', { name: 'Print 80 mm' }));
    await waitFor(() => {
      expect(print).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByTestId('print-layer')).toHaveAttribute('data-format', 'thermal');
    expect(requests.filter((request) => request.path.endsWith('/print'))).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'PDF' }));
    await waitFor(() => {
      expect(click).toHaveBeenCalledOnce();
    });
    expect(click.mock.contexts[0]?.download).toBe('AMP-26-27-000001.pdf');
    expect(requests.at(-1)?.query.get('lang')).toBe('en');
    pdf = 'bare';
    await user.click(screen.getByRole('button', { name: 'PDF' }));
    await waitFor(() => {
      expect(click).toHaveBeenCalledTimes(2);
    });
    expect(click.mock.contexts[1]?.download).toBe('AMP/26-27/000001.pdf');
    pdf = 'broken';
    await user.click(screen.getByRole('button', { name: 'PDF' }));
    expect(await screen.findByText('Only an issued invoice is printed')).toBeVisible();
  });

  it('shows why it cannot be printed', async () => {
    const { user } = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: routes({
        'GET /invoices/:id/print': () =>
          json(
            { statusCode: 409, message: 'Only an issued invoice or bill of supply is printed' },
            409,
          ),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Print A4' }));
    expect(
      await screen.findByText('Only an issued invoice or bill of supply is printed'),
    ).toBeVisible();
    expect(print).not.toHaveBeenCalled();
  });
});

describe('Cancelling an invoice', { timeout: 30_000 }, () => {
  it('explains the rules, warns after the day of issue and shows the API’s refusal', async () => {
    const { user } = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: routes({
        'POST /invoices/:id/cancel': () =>
          json(
            {
              statusCode: 409,
              message:
                'An invoice can be cancelled only on the day it was issued; raise a credit note instead',
            },
            409,
          ),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Cancel invoice' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel invoice AMP/26-27/000001' });
    expect(
      within(dialog).getByText(/only on the day it was issued, and only before/),
    ).toBeVisible();
    expect(
      within(dialog).getByText(/This invoice was issued on 8 Oct 2026, so it can no longer/),
    ).toBeVisible();
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'No');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel invoice' }));
    expect(within(dialog).getByText('Say why, in at least 3 characters')).toBeVisible();
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 't needed');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel invoice' }));
    expect(
      await within(dialog).findByText(
        'An invoice can be cancelled only on the day it was issued; raise a credit note instead',
      ),
    ).toBeVisible();
  });

  it('cancels a bill of the same day', async () => {
    const today = { ...INVOICE, issuedOn: todayInIndia() };
    let cancelled = false;
    const { user, requests } = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: routes({
        'GET /invoices/:id': () =>
          json(
            cancelled ? { ...today, status: 'cancelled', cancelReason: 'Wrong customer' } : today,
          ),
        'POST /invoices/:id/cancel': () => {
          cancelled = true;
          return json({ ...today, status: 'cancelled', cancelReason: 'Wrong customer' });
        },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Cancel invoice' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel invoice AMP/26-27/000001' });
    expect(within(dialog).queryByText(/can no longer be cancelled/)).toBeNull();
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Wrong customer');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel invoice' }));
    expect(await screen.findByText('Invoice AMP/26-27/000001 cancelled')).toBeVisible();
    expect(requests.find((request) => request.path.endsWith('/cancel'))?.body).toEqual({
      reason: 'Wrong customer',
    });
    expect(await screen.findByText('Wrong customer')).toBeVisible();
    // A cancelled invoice is neither printed nor cancelled again.
    expect(screen.queryByRole('button', { name: 'Print A4' })).toBeNull();
  });

  it('is offered only to members who may cancel', async () => {
    renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: routes({ 'GET /auth/me': () => json(profile(['sales:read'])) }),
    });
    expect(await screen.findByRole('button', { name: 'Print A4' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cancel invoice' })).toBeNull();
  });
});
