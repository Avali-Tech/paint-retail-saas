import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, profile } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import {
  CASH_SUPPLIER,
  ORDER,
  ORDER_SUMMARY,
  VIEWER,
  purchasingRoutes,
} from './test-support/fixtures.js';

const location = () => screen.getByTestId('location').textContent;

describe('PurchaseOrdersPage', () => {
  it('lists orders and filters by status, store and supplier', async () => {
    const { user, requests } = renderApp({
      path: '/purchase-orders',
      routes: {
        ...purchasingRoutes(),
        'GET /purchase-orders': () =>
          json({
            items: [
              ORDER_SUMMARY,
              { ...ORDER_SUMMARY, id: 'po-2', number: 'PO-000002', expectedDate: '2026-10-09' },
            ],
            total: 2,
          }),
      },
    });
    const table = await screen.findByRole('table', { name: 'Purchase orders' });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent(
      'PO-0000011 Oct 2026Shah DistributorsHYDPartly received—2₹4,000.00',
    );
    expect(rows[2]).toHaveTextContent('9 Oct 2026');
    expect(screen.getByRole('link', { name: 'Order from low stock' })).toHaveAttribute(
      'href',
      '/stock/low',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Open');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'HYD · Hyderabad');
    await screen.findByRole('option', { name: 'Shah Distributors' });
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Supplier' }),
      'Shah Distributors',
    );
    await waitFor(() => {
      const last = requests.filter((request) => request.path === '/purchase-orders').at(-1);
      expect(last?.query.toString()).toBe(
        'status=open&storeId=s-hyd&supplierId=sup-1&limit=50&offset=0',
      );
    });
    expect(location()).toBe('/purchase-orders?status=open&store=s-hyd&supplier=sup-1');
  });

  it('offers ordering from low stock only to those who can see stock', async () => {
    renderApp({
      path: '/purchase-orders',
      routes: purchasingRoutes(profile(['purchasing:read', 'purchasing:manage', 'stores:read'])),
    });
    expect(await screen.findByRole('link', { name: '+ Purchase order' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Order from low stock' })).toBeNull();
  });

  it('ignores an unknown status in the address and says when nothing is ordered', async () => {
    const { requests } = renderApp({
      path: '/purchase-orders?status=bogus',
      routes: {
        ...purchasingRoutes(VIEWER),
        'GET /purchase-orders': () => json({ items: [], total: 0 }),
      },
    });
    expect(await screen.findByText('No orders match these filters')).toBeInTheDocument();
    expect(
      requests.find((request) => request.path === '/purchase-orders')?.query.has('status'),
    ).toBe(false);
    expect(screen.queryByRole('link', { name: '+ Purchase order' })).toBeNull();
  });

  it('pages through many orders', async () => {
    const { user } = renderApp({
      path: '/purchase-orders',
      routes: {
        ...purchasingRoutes(),
        'GET /purchase-orders': () => json({ items: [ORDER_SUMMARY], total: 51 }),
      },
    });
    expect(await screen.findByText('1–50 of 51')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(location()).toBe('/purchase-orders?offset=50');
  });

  it('invites a first order', async () => {
    renderApp({
      path: '/purchase-orders',
      routes: {
        ...purchasingRoutes(),
        'GET /purchase-orders': () => json({ items: [], total: 0 }),
      },
    });
    expect(await screen.findByText('No purchase orders yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '+ Purchase order' })).toHaveAttribute(
      'href',
      '/purchase-orders/new',
    );
  });
});

describe('NewPurchaseOrderPage', () => {
  it('checks the order, then creates it with the supplier’s products', async () => {
    let body: unknown;
    const { user } = renderApp({
      path: '/purchase-orders/new',
      routes: {
        ...purchasingRoutes(),
        'POST /purchase-orders': (request) => {
          body = request.body;
          return json(ORDER, 201);
        },
        'GET /purchase-orders/:id': () => json(ORDER),
      },
    });
    const create = await screen.findByRole('button', { name: 'Create order' });
    await user.click(create);
    expect(
      screen.getByText('Choose a supplier', { selector: '.ui-field__error' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Choose a store', { selector: '.ui-field__error' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Add at least one product')).toBeInTheDocument();

    const supplier = screen.getByRole('combobox', { name: /^Supplier/ });
    await screen.findByRole('option', { name: 'Shah Distributors' });
    await user.selectOptions(supplier, 'Shah Distributors');
    await user.selectOptions(screen.getByRole('combobox', { name: /^Store/ }), 'HYD · Hyderabad');
    await user.click(await screen.findByRole('button', { name: "Add the supplier's products" }));
    expect(screen.queryByRole('button', { name: "Add the supplier's products" })).toBeNull();
    expect(screen.getByText('Last cost ₹400.00')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /Quantity of APX-1L/ }), '10');
    expect(screen.getByText('Value ₹4,000.00')).toBeInTheDocument();
    expect(screen.getByText('Total of known costs ₹4,000.00')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /Cost per unit of APX-4L/ }), 'abc');
    await user.click(create);
    expect(screen.getByText('Enter a cost in rupees')).toBeInTheDocument();
    expect(
      screen.getByText('Enter a quantity above zero, with at most 3 decimals'),
    ).toBeInTheDocument();
    await user.clear(screen.getByRole('textbox', { name: /Cost per unit of APX-4L/ }));
    await user.type(screen.getByRole('textbox', { name: /Cost per unit of APX-4L/ }), '1500');
    await user.type(screen.getByRole('textbox', { name: /Quantity of APX-4L/ }), '2');
    expect(screen.getByText('Total of known costs ₹7,000.00')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Add a product' }), 'tractor');
    await user.click(await screen.findByRole('button', { name: 'Add TE-10L' }));
    expect(screen.getByText('Value not known yet')).toBeInTheDocument();
    expect(screen.getAllByText('Leave blank to use the last cost')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Remove TE-10L' }));

    await user.type(screen.getByLabelText('Expected on'), '2026-10-05');
    await user.type(screen.getByRole('textbox', { name: 'Note' }), ' Before Diwali ');
    await user.click(create);
    expect(await screen.findByText('Purchase order PO-000001 created')).toBeInTheDocument();
    expect(body).toEqual({
      supplierId: 'sup-1',
      storeId: 's-hyd',
      expectedDate: '2026-10-05',
      note: 'Before Diwali',
      lines: [
        { variantId: 'v-1l', quantity: 10 },
        { variantId: 'v-4l', quantity: 2, unitCostPaise: 150_000 },
      ],
    });
    await waitFor(() => {
      expect(location()).toBe('/purchase-orders/po-1');
    });
  });

  it('starts from the supplier in the address and shows what the API refuses', async () => {
    const { user } = renderApp({
      path: '/purchase-orders/new?supplier=sup-2',
      routes: {
        ...purchasingRoutes(),
        'GET /suppliers/:id': () => json({ ...CASH_SUPPLIER, products: [] }),
        'POST /purchase-orders': () =>
          json({ statusCode: 404, message: 'Supplier not found' }, 404),
      },
    });
    await screen.findByRole('option', { name: 'Ravi Traders' });
    expect(screen.getByRole('combobox', { name: /^Supplier/ })).toHaveValue('sup-2');
    await user.selectOptions(screen.getByRole('combobox', { name: /^Store/ }), 'PUN · Pune');
    await user.type(screen.getByRole('searchbox', { name: 'Add a product' }), 'tractor');
    await user.click(await screen.findByRole('button', { name: 'Add TE-10L' }));
    await user.type(screen.getByRole('textbox', { name: /Quantity of TE-10L/ }), '1');
    await user.click(screen.getByRole('button', { name: 'Create order' }));
    expect(await screen.findByText('Supplier not found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "Add the supplier's products" })).toBeNull();
  });
});

describe('PurchaseOrderDetailPage', () => {
  it('shows the order and cancels it with a reason', async () => {
    let body: unknown;
    const { user } = renderApp({
      path: '/purchase-orders/po-1',
      routes: {
        ...purchasingRoutes(),
        'GET /purchase-orders/:id': () => json(ORDER),
        'POST /purchase-orders/:id/cancel': (request) => {
          body = request.body;
          return json({ ...ORDER, status: 'cancelled', closingReason: 'Wrong supplier' });
        },
      },
    });
    expect(await screen.findByRole('heading', { name: 'PO-000001' })).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Shah Distributors' })).toHaveAttribute(
      'href',
      '/suppliers/sup-1',
    );
    expect(screen.getByText('5 Oct 2026')).toBeInTheDocument();
    expect(screen.getByText('Before Diwali')).toBeInTheDocument();
    const rows = within(screen.getByRole('table', { name: 'Products' })).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Asian Paints Apex UltimaAPX-1L · 1 l10010₹400.00₹4,000.00');
    expect(rows[2]).toHaveTextContent('220——');
    expect(screen.getByText('Nothing received yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Receive goods' })).toHaveAttribute(
      'href',
      '/goods-receipts/new?order=po-1',
    );
    expect(screen.queryByRole('button', { name: 'Close short' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel PO-000001' });
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'no');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    expect(within(dialog).getByText(/at least 3 characters/)).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 't needed');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    expect(await screen.findByText('Order cancelled')).toBeInTheDocument();
    expect(body).toEqual({ reason: 'not needed' });
    expect(screen.getByText('Wrong supplier')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Receive goods' })).toBeNull();
  });

  it('closes a partly received order short and lists its receipts', async () => {
    const partial = {
      ...ORDER,
      status: 'partially_received' as const,
      note: null,
      expectedDate: null,
      receipts: [
        {
          id: 'grn-1',
          number: 'GRN-000001',
          supplierInvoiceNumber: 'INV-77',
          receivedAt: '2026-10-02T06:00:00.000Z',
        },
        {
          id: 'grn-2',
          number: 'GRN-000002',
          supplierInvoiceNumber: null,
          receivedAt: '2026-10-03T06:00:00.000Z',
        },
      ],
    };
    const { user } = renderApp({
      path: '/purchase-orders/po-1',
      routes: {
        ...purchasingRoutes(),
        'GET /purchase-orders/:id': () => json(partial),
        'POST /purchase-orders/:id/close': () =>
          json({ ...partial, status: 'closed', closingReason: 'Rest not coming' }),
      },
    });
    expect(await screen.findByRole('link', { name: 'GRN-000001' })).toHaveAttribute(
      'href',
      '/goods-receipts/grn-1',
    );
    expect(screen.getByText(/Invoice INV-77/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Close short' }));
    const dialog = screen.getByRole('dialog', { name: 'Close PO-000001 short' });
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Rest not coming');
    await user.click(within(dialog).getByRole('button', { name: 'Close short' }));
    expect(await screen.findByText('Order closed')).toBeInTheDocument();
    expect(screen.getByText('Closed short')).toBeInTheDocument();
  });

  it('shows the order as it is now when someone else changed it first', async () => {
    let loads = 0;
    const { user } = renderApp({
      path: '/purchase-orders/po-1',
      routes: {
        ...purchasingRoutes(),
        'GET /purchase-orders/:id': () => {
          loads += 1;
          return json(loads === 1 ? ORDER : { ...ORDER, status: 'partially_received' });
        },
        'POST /purchase-orders/:id/cancel': () =>
          json({ message: 'Goods have arrived against this order' }, 409),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Cancel order' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel PO-000001' });
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'not needed');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    expect(
      await within(dialog).findByText('Goods have arrived against this order'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Partly received')).toBeInTheDocument();
  });

  it('is read-only without purchasing:manage', async () => {
    renderApp({
      path: '/purchase-orders/po-1',
      routes: { ...purchasingRoutes(VIEWER), 'GET /purchase-orders/:id': () => json(ORDER) },
    });
    await screen.findByRole('heading', { name: 'PO-000001' });
    expect(screen.queryByRole('link', { name: 'Receive goods' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
  });

  it('says when the order cannot be loaded', async () => {
    renderApp({ path: '/purchase-orders/nope', routes: purchasingRoutes() });
    expect(await screen.findByText('Could not load this purchase order')).toBeInTheDocument();
  });
});
