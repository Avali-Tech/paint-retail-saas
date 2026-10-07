import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Transfer } from '../api/transfers.js';
import { CASHIER, OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { CHALLAN, inTransit, transfer, transferLine } from './test-support/fixtures.js';

function renderDetail(shown: Transfer, routes: Record<string, FakeHandler> = {}, member = OWNER) {
  return renderApp({
    path: '/transfers/transfer-1',
    routes: {
      'GET /auth/me': () => json(member),
      'GET /transfers/:id': () => json(shown),
      'GET /transfers/:id/challan': () => json(CHALLAN),
      ...routes,
    },
  });
}

const rows = (name: string) =>
  within(screen.getByRole('table', { name }))
    .getAllByRole('row')
    .map((row) => row.textContent);

const posted = (requests: { method: string; path: string; body: unknown }[], path: string) =>
  requests.find((request) => request.method === 'POST' && request.path === path)?.body;

describe('TransferDetailPage', () => {
  it('shows a request with what the sender has, and lets the sender approve less', async () => {
    const approved = transfer({
      status: 'approved',
      approvedAt: '2026-10-01T06:00:00.000Z',
      lines: [transferLine({ approvedQuantity: 8 })],
    });
    const { user, requests } = renderDetail(
      transfer({
        note: 'For the wedding order',
        lines: [
          transferLine(),
          transferLine({
            variantId: 'v-4l',
            sku: 'APX-4L',
            productName: 'Paint Brush',
            unit: 'piece',
            label: '2 inch',
            requestedQuantity: 2,
          }),
        ],
      }),
      { 'POST /transfers/:id/approve': () => json(approved) },
    );
    expect(await screen.findByRole('heading', { name: 'TR-000001', level: 1 })).toBeVisible();
    expect(screen.getByText('From HYD · Hyderabad to PUN · Pune')).toBeInTheDocument();
    expect(screen.getByText('Note: For the wedding order')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Progress' })).toHaveTextContent(/^Requested /);
    expect(rows('Products')).toEqual([
      'ProductRequestedAvailable at HYDApprovedDispatchedReceivedDamagedShort',
      'APX-1LAsian Paints Apex Ultima 1 l1012—————',
      'APX-4LAsian Paints Paint Brush 2 inch212—————',
    ]);
    expect(screen.getByRole('button', { name: 'Cancel request TR-000001' })).toBeInTheDocument();
    expect(screen.queryByText('Delivery challan')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Approve TR-000001' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve TR-000001' });
    const first = within(dialog).getByRole('textbox', { name: 'Quantity of APX-1L to approve' });
    expect(first).toHaveValue('10');
    await user.clear(first);
    await user.type(first, '11');
    const second = within(dialog).getByRole('textbox', { name: 'Quantity of APX-4L to approve' });
    await user.clear(second);
    await user.type(second, 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(within(dialog).getByText('Up to 10', { selector: 'p.ui-field__error' })).toBeVisible();
    expect(
      within(dialog).getByText('Enter a quantity of 0 or more, with at most 3 decimals'),
    ).toBeVisible();
    await user.clear(first);
    await user.type(first, '8');
    await user.clear(second);
    await user.type(second, '0');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Transfer approved')).toBeInTheDocument();
    expect(posted(requests, '/transfers/transfer-1/approve')).toEqual({
      lines: [
        { variantId: 'variant-1l', quantity: 8 },
        { variantId: 'v-4l', quantity: 0 },
      ],
    });
    expect(await screen.findByRole('button', { name: 'Dispatch TR-000001' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Progress' })).toHaveTextContent(/Approved /);
  });

  it('asks to reject instead of approving nothing', async () => {
    const { user, requests } = renderDetail(transfer());
    await user.click(await screen.findByRole('button', { name: 'Approve TR-000001' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve TR-000001' });
    const quantity = within(dialog).getByRole('textbox', { name: 'Quantity of APX-1L to approve' });
    await user.clear(quantity);
    await user.type(quantity, '0');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByText(/or reject the request instead/)).toBeVisible();
    expect(posted(requests, '/transfers/transfer-1/approve')).toBeUndefined();
  });

  it('rejects a request with a reason', async () => {
    const { user, requests } = renderDetail(transfer(), {
      'POST /transfers/:id/reject': () =>
        json(
          transfer({
            status: 'rejected',
            closingReason: 'Not enough stock',
            closedAt: '2026-10-01T06:00:00.000Z',
          }),
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Reject TR-000001' }));
    const dialog = screen.getByRole('dialog', { name: 'Reject TR-000001' });
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Not enough stock');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Reason: Not enough stock')).toBeInTheDocument();
    expect(screen.getByText('Transfer rejected')).toBeInTheDocument();
    expect(posted(requests, '/transfers/transfer-1/reject')).toEqual({
      reason: 'Not enough stock',
    });
    expect(screen.queryByRole('button', { name: /TR-000001$/ })).toBeNull();
  });

  it('lets the receiving store withdraw its request, but not approve it', async () => {
    const member = profile(undefined, { allStores: false, storeIds: ['store-pun'] });
    const { user, requests } = renderDetail(
      transfer({ status: 'approved', lines: [transferLine({ approvedQuantity: 10 })] }),
      { 'POST /transfers/:id/cancel': () => json(transfer({ status: 'cancelled' })) },
      member,
    );
    await user.click(await screen.findByRole('button', { name: 'Cancel request TR-000001' }));
    expect(screen.queryByRole('button', { name: 'Dispatch TR-000001' })).toBeNull();
    const dialog = screen.getByRole('dialog', { name: 'Cancel TR-000001' });
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Bought locally');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel request' }));
    expect(await screen.findByText('Transfer cancelled')).toBeInTheDocument();
    expect(posted(requests, '/transfers/transfer-1/cancel')).toEqual({ reason: 'Bought locally' });
  });

  it('dispatches up to what was approved, and shows the API’s refusal', async () => {
    let refuse = true;
    const { user, requests } = renderDetail(
      transfer({ status: 'approved', lines: [transferLine({ approvedQuantity: 8 })] }),
      {
        'POST /transfers/:id/dispatch': () =>
          refuse
            ? json({ statusCode: 409, message: 'Not enough APX-1L in stock' }, 409)
            : json(inTransit()),
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Dispatch TR-000001' }));
    const dialog = screen.getByRole('dialog', { name: 'Dispatch TR-000001' });
    expect(within(dialog).getByText('Stock leaves Hyderabad at its average cost.')).toBeVisible();
    const quantity = within(dialog).getByRole('textbox', {
      name: 'Quantity of APX-1L to dispatch',
    });
    expect(quantity).toHaveValue('8');
    await user.click(within(dialog).getByRole('button', { name: 'Dispatch' }));
    expect(await within(dialog).findByText('Not enough APX-1L in stock')).toBeVisible();
    refuse = false;
    await user.click(within(dialog).getByRole('button', { name: 'Dispatch' }));
    expect(await screen.findByText('Transfer dispatched')).toBeInTheDocument();
    expect(posted(requests, '/transfers/transfer-1/dispatch')).toEqual({
      lines: [{ variantId: 'variant-1l', quantity: 8 }],
    });
    expect(await screen.findByRole('region', { name: 'Delivery challan' })).toBeInTheDocument();
  });

  it('prints the delivery challan, flagging when a tax invoice is needed', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const { user } = renderDetail(inTransit(), {}, CASHIER);
    const challan = await screen.findByRole('region', { name: 'Delivery challan' });
    expect(await within(challan).findByText(/needs a tax invoice/)).toBeInTheDocument();
    expect(challan).toHaveTextContent('HYD · HyderabadHyderabad, TelanganaGSTIN 36AABCU9603R1ZM');
    expect(challan).toHaveTextContent('PUN · PuneNo GSTIN');
    expect(rows('Challan lines')).toEqual([
      'SKUDescriptionHSNQuantityUnit valueValue',
      'APX-1LAsian Paints Apex Ultima 1 l32098₹400.00₹3,200.00',
      'APX-4LAsian Paints Apex Ultima 4 l32091——',
    ]);
    expect(challan).toHaveTextContent('Total value₹3,200.00');
    await user.click(within(challan).getByRole('button', { name: 'Print challan' }));
    expect(print).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Receive TR-000001' })).toBeNull();
    print.mockRestore();
  });

  it('records what arrived: good, damaged and short', async () => {
    const received = inTransit({
      status: 'received',
      receivedAt: '2026-10-02T07:00:00.000Z',
      note: 'One tin dented',
      lines: [
        transferLine({
          approvedQuantity: 8,
          dispatchedQuantity: 8,
          receivedQuantity: 6,
          damagedQuantity: 1,
          shortQuantity: 1,
        }),
      ],
    });
    const { user, requests } = renderDetail(inTransit(), {
      'GET /transfers/:id/challan': () =>
        json({ ...CHALLAN, requiresTaxInvoice: false, lines: CHALLAN.lines.slice(0, 1) }),
      'POST /transfers/:id/receive': () => json(received),
    });
    await user.click(await screen.findByRole('button', { name: 'Receive TR-000001' }));
    const dialog = screen.getByRole('dialog', { name: 'Receive TR-000001' });
    const good = within(dialog).getByRole('textbox', { name: 'Good quantity of APX-1L' });
    const damaged = within(dialog).getByRole('textbox', { name: 'Damaged quantity of APX-1L' });
    expect(good).toHaveValue('8');
    expect(damaged).toHaveValue('0');
    await user.clear(good);
    await user.type(good, 'a');
    await user.clear(damaged);
    await user.type(damaged, 'b');
    await user.click(within(dialog).getByRole('button', { name: 'Receive' }));
    expect(
      within(dialog).getAllByText('Enter a quantity of 0 or more, with at most 3 decimals'),
    ).toHaveLength(2);
    await user.clear(good);
    await user.type(good, '8');
    await user.clear(damaged);
    await user.type(damaged, '1');
    await user.click(within(dialog).getByRole('button', { name: 'Receive' }));
    expect(within(dialog).getByText('More than the 8 dispatched')).toBeVisible();
    await user.clear(good);
    await user.type(good, '6');
    await user.type(
      within(dialog).getByRole('textbox', {
        name: 'Note (optional, replaces the note on the request)',
      }),
      ' One tin dented ',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Receive' }));

    expect(await screen.findByText('Transfer received')).toBeInTheDocument();
    expect(posted(requests, '/transfers/transfer-1/receive')).toEqual({
      note: 'One tin dented',
      lines: [{ variantId: 'variant-1l', received: 6, damaged: 1 }],
    });
    await waitFor(() => {
      expect(rows('Products')[1]).toBe('APX-1LAsian Paints Apex Ultima 1 l1088611');
    });
    expect(screen.getByRole('list', { name: 'Progress' })).toHaveTextContent(/Received /);
  });

  it('receives everything in good condition with no note', async () => {
    const two = inTransit({
      lines: [
        transferLine({ approvedQuantity: 8, dispatchedQuantity: 8 }),
        transferLine({
          variantId: 'v-4l',
          sku: 'APX-4L',
          approvedQuantity: 2,
          dispatchedQuantity: 2,
        }),
      ],
    });
    const { user, requests } = renderDetail(two, {
      'POST /transfers/:id/receive': () => json({ ...two, status: 'received' }),
    });
    await user.click(await screen.findByRole('button', { name: 'Receive TR-000001' }));
    const dialog = screen.getByRole('dialog', { name: 'Receive TR-000001' });
    const damaged = within(dialog).getByRole('textbox', { name: 'Damaged quantity of APX-4L' });
    await user.clear(damaged);
    await user.type(damaged, '0');
    await user.click(within(dialog).getByRole('button', { name: 'Receive' }));
    expect(await screen.findByText('Transfer received')).toBeInTheDocument();
    expect(posted(requests, '/transfers/transfer-1/receive')).toEqual({
      lines: [
        { variantId: 'variant-1l', received: 8, damaged: 0 },
        { variantId: 'v-4l', received: 2, damaged: 0 },
      ],
    });
  });

  it('says when the transfer cannot be seen', async () => {
    renderDetail(transfer(), {
      'GET /transfers/:id': () => json({ statusCode: 404, message: 'Transfer not found' }, 404),
    });
    expect(await screen.findByText('Could not load this transfer')).toBeInTheDocument();
  });
});
