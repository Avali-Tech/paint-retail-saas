import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CASHIER, OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { found } from '../test-support/found.js';
import { APEX, page, product, stockRow, variant } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';

function renderDetail(routes: Record<string, FakeHandler> = {}, member = OWNER) {
  return renderApp({
    path: '/products/product-apex',
    routes: {
      'GET /auth/me': () => json(member),
      'GET /products/:id': () => json(APEX),
      'GET /stock': () => json(page([stockRow()])),
      ...routes,
    },
  });
}

const variantRows = () =>
  within(screen.getByRole('table', { name: 'Pack sizes' }))
    .getAllByRole('row')
    .map((row) => row.textContent);

describe('ProductDetailPage', () => {
  it('shows the product, its pack sizes and prices, and stock by store', async () => {
    const { requests } = renderDetail({
      'GET /products/:id': () =>
        json(
          product({
            description: 'Weatherproof exterior emulsion',
            category: { id: 'cat-emulsion', name: 'Emulsions', parentId: null },
            isActive: false,
            variants: [
              variant(),
              variant({
                id: 'v-20',
                sku: 'APX-20L',
                isActive: false,
                mrpPaise: null,
                barcodes: [],
              }),
            ],
          }),
        ),
    });
    expect(await screen.findByRole('heading', { name: 'Apex Ultima', level: 1 })).toBeVisible();
    expect(screen.getByText('HSN 3209 · GST 18%')).toBeInTheDocument();
    expect(screen.getByText('Emulsions')).toBeInTheDocument();
    expect(screen.getByText('Weatherproof exterior emulsion')).toBeInTheDocument();
    expect(variantRows()).toEqual([
      'SKUSizeMRP (₹)Selling price (₹)BarcodesEdit',
      'APX-1L1 l₹500.00₹450.008901234567890Edit APX-1L',
      'APX-20L Inactive1 l—₹450.00—Edit APX-20L',
    ]);
    const stock = await screen.findByRole('table', { name: 'Stock by store' });
    expect(within(stock).getAllByRole('row')[1]).toHaveTextContent('HYDAPX-1L1210');
    expect(requests.find((request) => request.path === '/stock')?.query.get('productId')).toBe(
      'product-apex',
    );
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/products/product-apex/edit',
    );
  });

  it('is read-only for staff who cannot manage the catalogue', async () => {
    renderDetail({ 'GET /stock': () => json(page([])) }, CASHIER);
    await screen.findByRole('heading', { name: 'Apex Ultima', level: 1 });
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add pack size' })).toBeNull();
    expect(variantRows()[0]).toBe('SKUSizeMRP (₹)Selling price (₹)Barcodes');
    expect(
      await screen.findByText('None of your stores has this product in stock.'),
    ).toBeInTheDocument();
  });

  it('leaves stock out for members without inventory access', async () => {
    const { requests } = renderDetail({}, profile(['catalog:read']));
    await screen.findByRole('heading', { name: 'Apex Ultima', level: 1 });
    expect(screen.queryByRole('region', { name: 'Stock by store' })).toBeNull();
    expect(requests.some((request) => request.path === '/stock')).toBe(false);
  });

  it('says when the product cannot be found', async () => {
    renderDetail({ 'GET /products/:id': () => json({ message: 'Product not found' }, 404) });
    expect(await screen.findByText('Could not load this product')).toBeInTheDocument();
    expect(
      screen.getByText('This record does not exist, or you cannot see it.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('adds a pack size', async () => {
    const saved = product({
      variants: [...APEX.variants, variant({ id: 'v-10', sku: 'APX-10L', packSize: 10 })],
    });
    let body: unknown;
    const { user } = renderDetail({
      'POST /products/:id/variants': (request) => {
        body = request.body;
        return json(saved, 201);
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Add pack size' }));
    const dialog = screen.getByRole('dialog', { name: 'Add pack size' });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText('Use 2 to 40 letters, digits or . _ / -')).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: 'SKU' }), 'apx-10l');
    await user.type(within(dialog).getByRole('textbox', { name: 'Size' }), '10');
    await user.type(within(dialog).getByRole('textbox', { name: 'MRP (₹)' }), '3500');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(body).toEqual({
      sku: 'APX-10L',
      packSize: 10,
      unit: 'l',
      mrpPaise: 350_000,
      barcodes: [],
    });
    expect(await screen.findByText('Pack size added')).toBeInTheDocument();
    expect(variantRows()).toHaveLength(4);
  });

  it('changes a pack size’s prices and shows the API’s refusal', async () => {
    let attempts = 0;
    let body: unknown;
    const { user } = renderDetail({
      'PATCH /variants/:id': (request) => {
        attempts += 1;
        body = request.body;
        return attempts === 1
          ? json({ message: 'SKU APX-4L is already in use' }, 409)
          : json(
              product({
                variants: [variant({ sellingPricePaise: 42_000 }), found(APEX.variants[1])],
              }),
            );
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Edit APX-1L' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit APX-1L' });
    expect(within(dialog).queryByRole('textbox', { name: 'Size' })).toBeNull();
    const selling = within(dialog).getByRole('textbox', { name: 'Selling price (₹)' });
    await user.clear(selling);
    await user.type(selling, '600');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText('Selling price cannot exceed the MRP')).toBeInTheDocument();
    await user.clear(selling);
    await user.type(selling, '420');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Active' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('SKU APX-4L is already in use')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(body).toEqual({
      sku: 'APX-1L',
      mrpPaise: 50_000,
      sellingPricePaise: 42_000,
      barcodes: ['8901234567890'],
      isActive: false,
    });
    expect(await screen.findByText('Pack size saved')).toBeInTheDocument();
    expect(found(variantRows()[1])).toContain('₹420.00');
  });

  it('closes a dialog without saving', async () => {
    const { user, requests } = renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Edit APX-4L' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
  });
});
