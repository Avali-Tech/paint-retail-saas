import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CASHIER, OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { STORES, lowItem, page } from '../test-support/inventory-fixtures.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';

const location = () => screen.getByTestId('location').textContent;

const SUPPLIER = {
  id: 'supplier-shah',
  name: 'Shah Distributors',
  phone: null,
  gstin: null,
  paymentTermsDays: 30,
  leadTimeDays: 3,
  productCount: 2,
};

const ITEMS = [
  lowItem(),
  lowItem({
    variant: { id: 'variant-4l', sku: 'APX-4L' },
    severity: 'out_of_stock',
    onHand: 0,
    available: 0,
    suggestedQuantity: 20,
  }),
];

function renderLow(
  routes: Record<string, FakeHandler> = {},
  { member = OWNER, path = '/stock/low' } = {},
) {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(member),
      'GET /stores': () => json(STORES),
      'GET /stock/low': () => json(page(ITEMS)),
      'GET /suppliers': () => json(page([SUPPLIER])),
      ...routes,
    },
  });
}

describe('LowStockPage', () => {
  it('lists low items with how urgent they are and what to order', async () => {
    renderLow();
    const table = await screen.findByRole('table', { name: 'Low stock items' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      'ProductStoreStatusAvailableReorder atSuggested order',
      'Asian Paints Apex UltimaAPX-1LHYDBelow minimum1519',
      'Asian Paints Apex UltimaAPX-4LHYDOut of stock0520',
    ]);
    expect(screen.getByText('Choose one store above to order for it')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create purchase order' })).toBeNull();
  });

  it('orders the selected items at one store from a supplier', async () => {
    let body: unknown;
    const { user, requests } = renderLow(
      {
        'POST /purchase-orders/from-low-stock': (request) => {
          body = request.body;
          return json({ id: 'po-1', number: 'PO-000001', totalValuePaise: 0 }, 201);
        },
      },
      { path: '/stock/low?store=store-hyd' },
    );
    await user.click(await screen.findByRole('checkbox', { name: 'Select APX-4L' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select APX-1L' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select APX-1L' }));
    expect(requests.find((request) => request.path === '/stock/low')?.query.get('storeId')).toBe(
      'store-hyd',
    );
    await user.click(screen.getByRole('button', { name: 'Create purchase order' }));
    const dialog = screen.getByRole('dialog', { name: 'Purchase order from low stock' });
    expect(dialog).toHaveTextContent('For the 1 selected items at Hyderabad');
    await user.click(within(dialog).getByRole('button', { name: 'Create order' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose a supplier');
    await user.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Supplier' }),
      'Shah Distributors',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Create order' }));
    await waitFor(() => {
      expect(location()).toBe('/purchase-orders/po-1');
    });
    expect(body).toEqual({
      supplierId: 'supplier-shah',
      storeId: 'store-hyd',
      variantIds: ['variant-4l'],
    });
    expect(await screen.findByText('Purchase order PO-000001 created')).toBeInTheDocument();
  });

  it('orders everything low when nothing is selected, and shows refusals', async () => {
    let body: unknown;
    const { user } = renderLow(
      {
        'POST /purchase-orders/from-low-stock': (request) => {
          body = request.body;
          return json(
            { message: 'Nothing at this store needs reordering from this supplier' },
            400,
          );
        },
      },
      { path: '/stock/low?store=store-hyd' },
    );
    await user.click(await screen.findByRole('button', { name: 'Create purchase order' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('For every low item at Hyderabad that this supplier provides');
    await user.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Supplier' }),
      'Shah Distributors',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Create order' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Nothing at this store needs reordering from this supplier',
    );
    expect(body).toEqual({ supplierId: 'supplier-shah', storeId: 'store-hyd' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks for a supplier first when there is none', async () => {
    const { user } = renderLow(
      { 'GET /suppliers': () => json(page([])) },
      { path: '/stock/low?store=store-hyd' },
    );
    await user.click(await screen.findByRole('button', { name: 'Create purchase order' }));
    expect(
      await screen.findByText('Add a supplier (a party with the supplier role) first'),
    ).toBeInTheDocument();
  });

  it('clears the selection when the store changes', async () => {
    const { user } = renderLow({}, { path: '/stock/low?store=store-hyd' });
    const box = await screen.findByRole('checkbox', { name: 'Select APX-1L' });
    await user.click(box);
    expect(box).toBeChecked();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'PUN · Pune');
    await waitFor(() => {
      expect(location()).toBe('/stock/low?store=store-pun');
    });
    expect(await screen.findByRole('checkbox', { name: 'Select APX-1L' })).not.toBeChecked();
  });

  it('says when nothing is low, linking to the reorder rules', async () => {
    renderLow({ 'GET /stock/low': () => json(page([])) });
    const empty = found((await screen.findByText('Nothing is low')).closest('div'));
    expect(within(empty).getByRole('link', { name: 'Reorder rules' })).toHaveAttribute(
      'href',
      '/stock/reorder-rules',
    );
  });

  it('lets staff without purchasing rights look but not order', async () => {
    renderLow({}, { member: CASHIER, path: '/stock/low?store=store-hyd' });
    await screen.findByRole('table', { name: 'Low stock items' });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create purchase order' })).toBeNull();
    expect(screen.queryByText('Choose one store above to order for it')).toBeNull();
  });

  it('pages through a long list', async () => {
    const { user, requests } = renderLow({ 'GET /stock/low': () => json(page(ITEMS, 150)) });
    const pages = await screen.findByRole('navigation', { name: 'Low stock pages' });
    await user.click(within(pages).getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(location()).toBe('/stock/low?offset=100');
    });
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('offset')).toBe('100');
    });
  });

  it('shows a loading problem', async () => {
    renderLow({ 'GET /stock/low': () => json({ message: 'Down' }, 503) });
    expect(await screen.findByText('Could not load low stock')).toBeInTheDocument();
  });
});
