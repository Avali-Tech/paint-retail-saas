import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { ADJUSTMENTS, DRAFT, INVOICE } from '../test-support/sales-fixtures.js';
import { DISPATCHES } from './test-support/order-fixtures.js';

const routes = (overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> => ({
  'GET /auth/me': () => json(OWNER),
  'GET /invoices/:id': () => json(INVOICE),
  'GET /invoices/:id/adjustments': () => json(ADJUSTMENTS),
  'GET /invoices/:id/dispatches': () => json(DISPATCHES),
  ...overrides,
});

const panel = () => screen.findByRole('region', { name: 'Dispatch' });

describe('dispatch on the invoice page', { timeout: 30_000 }, () => {
  it('shows what has gone and records a dispatch with its e-way bill', async () => {
    let posted = false;
    const { user, requests } = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: routes({
        // Above ₹500 the goods need an e-way bill.
        'GET /invoices/:id/dispatches': () =>
          json(
            posted
              ? {
                  ...DISPATCHES,
                  lines: DISPATCHES.lines.map((line) => ({ ...line, pendingQuantity: 0 })),
                }
              : { ...DISPATCHES, ewayThresholdPaise: 50_000 },
          ),
        'POST /invoices/:id/dispatches': () => {
          posted = true;
          return json(DISPATCHES.dispatches[0], 201);
        },
      }),
    });
    const card = await panel();
    const table = within(card).getByRole('table', { name: 'Dispatch lines' });
    expect(within(table).getAllByRole('row')[2]).toHaveTextContent('—211');
    expect(card).toHaveTextContent(
      'DS-0000038 Oct 2026, 12:30 pm · ₹500.00 · TS09AB1234 · E-way bill 123456789012',
    );
    expect(card).toHaveTextContent('DS-0000048 Oct 2026, 1:30 pm · ₹0.00');

    await user.click(within(card).getByRole('button', { name: 'Dispatch goods' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dispatch for AMP/26-27/000001' });
    expect(within(dialog).getByText('Stock leaves the store with this dispatch.')).toBeVisible();
    const apex = within(dialog).getByRole('textbox', { name: /^Apex Ultima 1 l/ });
    const other = within(dialog).getByRole('textbox', { name: /^—/ });
    await user.clear(apex);
    await user.type(apex, '2');
    await user.click(within(dialog).getByRole('button', { name: 'Record dispatch' }));
    expect(within(dialog).getByText('Check the quantity of Apex Ultima 1 l')).toBeVisible();
    await user.clear(apex);
    await user.clear(other);
    await user.click(within(dialog).getByRole('button', { name: 'Record dispatch' }));
    expect(within(dialog).getByText('Enter at least one quantity to dispatch')).toBeVisible();
    await user.type(other, 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Record dispatch' }));
    expect(within(dialog).getByText('Check the quantity of —')).toBeVisible();
    await user.clear(other);
    await user.type(other, '1');
    await user.type(apex, '1');
    await user.click(within(dialog).getByRole('button', { name: 'Record dispatch' }));
    expect(
      within(dialog).getByText('Goods worth ₹618.00 need an e-way bill (above ₹500.00).'),
    ).toBeVisible();
    const eway = within(dialog).getByRole('textbox', { name: /^E-way bill number/ });
    await user.type(eway, '1234');
    await user.click(within(dialog).getByRole('button', { name: 'Record dispatch' }));
    expect(within(dialog).getByText('An e-way bill number has 12 digits')).toBeVisible();
    await user.clear(eway);
    await user.type(eway, '123456789012');
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Vehicle number' }),
      ' ts09ab1234 ',
    );
    fireEvent.change(within(dialog).getByLabelText('E-way bill valid until'), {
      target: { value: '2026-10-09' },
    });
    await user.type(within(dialog).getByRole('textbox', { name: 'Note' }), ' Call before ');
    await user.click(within(dialog).getByRole('button', { name: 'Record dispatch' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const post = requests.find((request) => request.method === 'POST');
    expect(post?.body).toEqual({
      lines: [
        { invoiceLineId: 'line-1', quantity: 1 },
        { invoiceLineId: 'line-2', quantity: 1 },
      ],
      vehicleNo: 'TS09AB1234',
      ewayBillNo: '123456789012',
      ewayValidUntil: '2026-10-09',
      note: 'Call before',
    });
    expect(post?.headers['Idempotency-Key']).toEqual(expect.any(String));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Dispatch goods' })).toBeNull();
    });
    // Everything has gone, and the button with it: the focus is on the invoice's heading.
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: 'Invoice AMP/26-27/000001' }),
      ).toHaveFocus();
    });
  });

  it('records a small dispatch without an e-way bill when stock left at issue', async () => {
    const { user, requests } = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: routes({
        'GET /invoices/:id/dispatches': () =>
          json({ ...DISPATCHES, stockPosting: 'on_issue', dispatches: [] }),
        'POST /invoices/:id/dispatches': () => json(DISPATCHES.dispatches[1], 201),
      }),
    });
    const card = await panel();
    expect(within(card).getByText('Nothing dispatched yet.')).toBeVisible();
    await user.click(within(card).getByRole('button', { name: 'Dispatch goods' }));
    const dialog = await screen.findByRole('dialog');
    const apex = within(dialog).getByRole('textbox', { name: /^Apex Ultima 1 l/ });
    await user.clear(apex);
    await user.type(apex, '0');
    expect(
      within(dialog).getByText(
        'Stock left when the invoice was issued; this records the delivery.',
      ),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Record dispatch' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(requests.find((request) => request.method === 'POST')?.body).toEqual({
      lines: [{ invoiceLineId: 'line-2', quantity: 1 }],
    });
  });

  it('closes the dialog unchanged, and hides the button from readers', async () => {
    const first = renderApp({ path: `/invoices/${INVOICE.id}`, routes: routes() });
    await first.user.click(within(await panel()).getByRole('button', { name: 'Dispatch goods' }));
    await first.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    first.unmount();
    renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: routes({ 'GET /auth/me': () => json(profile(['stores:read', 'sales:read'])) }),
    });
    expect(within(await panel()).queryByRole('button', { name: 'Dispatch goods' })).toBeNull();
  });

  it('says when dispatches cannot be loaded, and shows none on a draft', async () => {
    const first = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: routes({ 'GET /invoices/:id/dispatches': () => json({ message: 'Down' }, 500) }),
    });
    expect(await screen.findByText('Could not load the dispatches')).toBeVisible();
    first.unmount();
    const second = renderApp({
      path: `/invoices/${DRAFT.id}`,
      routes: routes({ 'GET /invoices/:id': () => json(DRAFT) }),
    });
    expect(await screen.findByRole('heading', { name: 'Draft bill', level: 1 })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Dispatch' })).toBeNull();
    expect(second.requests.some((request) => request.path.endsWith('/dispatches'))).toBe(false);
  });
});
