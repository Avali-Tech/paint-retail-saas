import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import {
  ORDER,
  RECEIPT,
  RECEIPT_SUMMARY,
  VIEWER,
  purchasingRoutes,
} from './test-support/fixtures.js';

const location = () => screen.getByTestId('location').textContent;

describe('GoodsReceiptsPage', () => {
  it('lists receipts and filters by store and supplier', async () => {
    const { user, requests } = renderApp({
      path: '/goods-receipts',
      routes: {
        ...purchasingRoutes(),
        'GET /goods-receipts': () =>
          json({
            items: [
              RECEIPT_SUMMARY,
              {
                ...RECEIPT_SUMMARY,
                id: 'grn-2',
                number: 'GRN-000002',
                purchaseOrderNumber: null,
                supplierInvoiceNumber: 'INV-9',
              },
            ],
            total: 2,
          }),
      },
    });
    const rows = within(await screen.findByRole('table', { name: 'Goods receipts' })).getAllByRole(
      'row',
    );
    expect(rows[1]).toHaveTextContent('GRN-000001Shah DistributorsHYDPO-000001—');
    expect(rows[2]).toHaveTextContent('GRN-000002Shah DistributorsHYD—INV-9');
    expect(screen.getByRole('link', { name: 'Receive goods' })).toHaveAttribute(
      'href',
      '/goods-receipts/new',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'PUN · Pune');
    await screen.findByRole('option', { name: 'Ravi Traders' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Supplier' }), 'Ravi Traders');
    await waitFor(() => {
      const last = requests.filter((request) => request.path === '/goods-receipts').at(-1);
      expect(last?.query.get('supplierId')).toBe('sup-2');
    });
    expect(location()).toBe('/goods-receipts?store=s-pun&supplier=sup-2');
  });

  it('pages through many receipts', async () => {
    const { user } = renderApp({
      path: '/goods-receipts',
      routes: {
        ...purchasingRoutes(),
        'GET /goods-receipts': () => json({ items: [RECEIPT_SUMMARY], total: 75 }),
      },
    });
    expect(await screen.findByText('1–50 of 75')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(location()).toBe('/goods-receipts?offset=50');
  });

  it('says when nothing has been received, or nothing matches', async () => {
    const empty = {
      ...purchasingRoutes(VIEWER),
      'GET /goods-receipts': () => json({ items: [], total: 0 }),
    };
    const first = renderApp({ path: '/goods-receipts', routes: empty });
    expect(await screen.findByText('Nothing received yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Receive goods' })).toBeNull();
    first.unmount();
    renderApp({ path: '/goods-receipts?store=s-hyd', routes: empty });
    expect(await screen.findByText('No receipts match these filters')).toBeInTheDocument();
  });
});

describe('NewGoodsReceiptPage against an order', () => {
  it('starts with what is still due, takes free units, and saves', async () => {
    let body: unknown;
    const { user } = renderApp({
      path: '/goods-receipts/new?order=po-1',
      routes: {
        ...purchasingRoutes(),
        'GET /purchase-orders/:id': () => json(ORDER),
        'POST /goods-receipts': (request) => {
          body = request.body;
          return json(RECEIPT, 201);
        },
        'GET /goods-receipts/:id': () => json(RECEIPT),
      },
    });
    expect(
      await screen.findByText('Against PO-000001 from Shah Distributors, for Hyderabad'),
    ).toBeInTheDocument();
    const quantity = screen.getByRole('textbox', { name: 'Quantity of APX-1L' });
    expect(quantity).toHaveValue('10');
    expect(screen.queryByRole('textbox', { name: 'Quantity of APX-4L' })).toBeNull();
    expect(screen.getByText('10 still due')).toBeInTheDocument();
    expect(screen.getByText('Order cost ₹400.00')).toBeInTheDocument();
    expect(screen.getByText('Total ₹4,000.00')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox', { name: 'Add a product' })).toBeNull();

    await user.clear(quantity);
    await user.type(quantity, '11');
    await user.click(screen.getByRole('button', { name: 'Save receipt' }));
    expect(screen.getByText('More than is still due on the order')).toBeInTheDocument();

    await user.clear(quantity);
    await user.type(quantity, '6');
    const free = screen.getByRole('textbox', { name: 'Free quantity of APX-1L' });
    await user.clear(free);
    await user.type(free, '1');
    await user.type(screen.getByLabelText('Invoice date'), '2026-10-02');
    await user.click(screen.getByRole('button', { name: 'Save receipt' }));
    expect(screen.getByText('Enter the invoice number along with its date')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Supplier invoice number' }), ' INV-77 ');
    await user.type(screen.getByRole('textbox', { name: 'Note' }), 'Two dented');
    await user.type(screen.getByRole('textbox', { name: /Cost per unit of APX-1L/ }), '390');
    expect(screen.getByText('Total ₹2,340.00')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save receipt' }));
    expect(await screen.findByText('Goods receipt GRN-000001 saved')).toBeInTheDocument();
    expect(body).toEqual({
      purchaseOrderId: 'po-1',
      supplierInvoiceNumber: 'INV-77',
      supplierInvoiceDate: '2026-10-02',
      note: 'Two dented',
      lines: [{ variantId: 'v-1l', quantity: 6, freeQuantity: 1, unitCostPaise: 39_000 }],
    });
    await waitFor(() => {
      expect(location()).toBe('/goods-receipts/grn-1');
    });
  });

  it('receives everything due without an invoice', async () => {
    let body: unknown;
    const { user } = renderApp({
      path: '/goods-receipts/new?order=po-1',
      routes: {
        ...purchasingRoutes(),
        'GET /purchase-orders/:id': () => json(ORDER),
        'POST /goods-receipts': (request) => {
          body = request.body;
          return json(RECEIPT, 201);
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Save receipt' }));
    await screen.findByText('Goods receipt GRN-000001 saved');
    expect(body).toEqual({
      purchaseOrderId: 'po-1',
      lines: [{ variantId: 'v-1l', quantity: 10, freeQuantity: 0 }],
    });
  });

  it('needs at least one line', async () => {
    const both = {
      ...ORDER,
      lines: ORDER.lines.map((line) => ({ ...line, pendingQuantity: 2 })),
    };
    const { user } = renderApp({
      path: '/goods-receipts/new?order=po-1',
      routes: { ...purchasingRoutes(), 'GET /purchase-orders/:id': () => json(both) },
    });
    const free = await screen.findByRole('textbox', { name: 'Free quantity of APX-4L' });
    await user.type(free, '1');
    expect(free).toHaveValue('01');
    expect(screen.getByRole('textbox', { name: 'Free quantity of APX-1L' })).toHaveValue('0');
    await user.click(screen.getByRole('button', { name: 'Remove APX-4L' }));
    await user.click(screen.getByRole('button', { name: 'Remove APX-1L' }));
    await user.click(screen.getByRole('button', { name: 'Save receipt' }));
    expect(screen.getByText('Add at least one product')).toBeInTheDocument();
  });

  it('refuses an order that is already closed', async () => {
    renderApp({
      path: '/goods-receipts/new?order=po-1',
      routes: {
        ...purchasingRoutes(),
        'GET /purchase-orders/:id': () => json({ ...ORDER, status: 'closed' }),
      },
    });
    expect(
      await screen.findByText(
        'This order is closed short; nothing more can be received against it.',
      ),
    ).toBeInTheDocument();
  });

  it('says when the order cannot be loaded', async () => {
    renderApp({ path: '/goods-receipts/new?order=nope', routes: purchasingRoutes() });
    expect(await screen.findByText('Could not load this purchase order')).toBeInTheDocument();
  });
});

describe('NewGoodsReceiptPage against an invoice', () => {
  it('needs the supplier, store and invoice, and shows a duplicate invoice', async () => {
    let body: unknown;
    const { user } = renderApp({
      path: '/goods-receipts/new',
      routes: {
        ...purchasingRoutes(),
        'POST /goods-receipts': (request) => {
          body = request.body;
          return json(
            { statusCode: 409, message: 'Invoice INV-9 from this supplier is already entered' },
            409,
          );
        },
      },
    });
    expect(await screen.findByText(/Against a supplier invoice/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save receipt' }));
    expect(
      screen.getByText('Choose a supplier', { selector: '.ui-field__error' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Choose a store', { selector: '.ui-field__error' }),
    ).toBeInTheDocument();
    expect(screen.getByText("Enter the supplier's invoice number")).toBeInTheDocument();
    expect(screen.getByText('Add at least one product')).toBeInTheDocument();

    await screen.findByRole('option', { name: 'Shah Distributors' });
    await user.selectOptions(
      screen.getByRole('combobox', { name: /^Supplier/ }),
      'Shah Distributors',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: /^Store/ }), 'HYD · Hyderabad');
    await user.type(screen.getByRole('textbox', { name: /Supplier invoice number/ }), 'INV-9');
    await user.type(screen.getByRole('searchbox', { name: 'Add a product' }), 'tractor');
    await user.click(await screen.findByRole('button', { name: 'Add TE-10L' }));
    expect(screen.getByText('Value not known yet')).toBeInTheDocument();
    const quantity = screen.getByRole('textbox', { name: 'Quantity of TE-10L' });
    await user.type(quantity, '0');
    await user.click(screen.getByRole('button', { name: 'Save receipt' }));
    expect(screen.getByText('Receive at least some of this product')).toBeInTheDocument();
    await user.clear(quantity);
    await user.type(quantity, '4');
    await user.click(screen.getByRole('button', { name: 'Save receipt' }));
    expect(
      await screen.findByText('Invoice INV-9 from this supplier is already entered'),
    ).toBeInTheDocument();
    expect(body).toEqual({
      supplierId: 'sup-1',
      storeId: 's-hyd',
      supplierInvoiceNumber: 'INV-9',
      lines: [{ variantId: 'v-te', quantity: 4, freeQuantity: 0 }],
    });
  });

  it("values a product at the supplier's last cost", async () => {
    const { user } = renderApp({
      path: '/goods-receipts/new',
      routes: {
        ...purchasingRoutes(),
        'GET /products/lookup': () =>
          json({
            product: {
              id: 'p-apx',
              name: 'Apex Ultima',
              type: 'exterior_paint',
              description: null,
              hsnCode: '3209',
              gstRatePercent: 18,
              isActive: true,
              brand: { id: 'b-1', name: 'Asian Paints' },
              category: null,
              variants: [],
            },
            variant: {
              id: 'v-1l',
              sku: 'APX-1L',
              packSize: 1,
              unit: 'l',
              mrpPaise: null,
              sellingPricePaise: null,
              isActive: true,
              barcodes: [],
            },
          }),
      },
    });
    await screen.findByRole('option', { name: 'Shah Distributors' });
    await user.selectOptions(
      screen.getByRole('combobox', { name: /^Supplier/ }),
      'Shah Distributors',
    );
    await user.type(screen.getByRole('searchbox', { name: 'Add a product' }), 'APX-1L{Enter}');
    await user.type(await screen.findByRole('textbox', { name: 'Quantity of APX-1L' }), '2');
    expect(await screen.findByText('Last cost ₹400.00')).toBeInTheDocument();
    expect(screen.getByText('Value ₹800.00')).toBeInTheDocument();
  });
});

describe('GoodsReceiptDetailPage', () => {
  it('shows what arrived, free units and the value', async () => {
    renderApp({
      path: '/goods-receipts/grn-1',
      routes: { ...purchasingRoutes(), 'GET /goods-receipts/:id': () => json(RECEIPT) },
    });
    expect(await screen.findByRole('heading', { name: 'GRN-000001' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PO-000001' })).toHaveAttribute(
      'href',
      '/purchase-orders/po-1',
    );
    expect(screen.getByText('INV-77')).toBeInTheDocument();
    expect(screen.getByText('2 Oct 2026')).toBeInTheDocument();
    expect(screen.getByText('Two dented')).toBeInTheDocument();
    const rows = within(screen.getByRole('table', { name: 'Products' })).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Asian Paints Apex UltimaAPX-1L61₹400.00₹2,400.00');
    expect(rows[2]).toHaveTextContent('10——');
    expect(screen.getByText(/Total/)).toHaveTextContent('Total ₹2,400.00');
  });

  it('shows a receipt without an order or invoice', async () => {
    renderApp({
      path: '/goods-receipts/grn-1',
      routes: {
        ...purchasingRoutes(),
        'GET /goods-receipts/:id': () =>
          json({
            ...RECEIPT,
            purchaseOrder: null,
            supplierInvoiceNumber: null,
            supplierInvoiceDate: null,
            note: null,
          }),
      },
    });
    expect(await screen.findByText('None')).toBeInTheDocument();
    expect(screen.queryByText('Two dented')).toBeNull();
  });

  it('says when the receipt cannot be loaded', async () => {
    renderApp({ path: '/goods-receipts/nope', routes: purchasingRoutes() });
    expect(await screen.findByText('Could not load this goods receipt')).toBeInTheDocument();
  });
});
