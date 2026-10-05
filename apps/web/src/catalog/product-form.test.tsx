import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { APEX, BRANDS, CATEGORIES, product } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { initialValues } from './ProductFormPage.js';

const location = () => screen.getByTestId('location').textContent;

function renderForm(path: string, routes: Record<string, FakeHandler> = {}) {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(OWNER),
      'GET /brands': () => json(BRANDS),
      'GET /categories': () => json(CATEGORIES),
      'GET /products/:id': () => json(APEX),
      'GET /stock': () => json({ items: [], total: 0 }),
      ...routes,
    },
  });
}

describe('initialValues', () => {
  it('starts a new product with one empty pack size and fills an existing one', () => {
    expect(initialValues(null)).toMatchObject({
      brandId: '',
      hsnCode: '3209',
      gstRatePercent: '18',
      variants: [{ sku: '', unit: 'l' }],
    });
    expect(
      initialValues(
        product({
          description: 'Tough',
          category: { id: 'cat-emulsion', name: 'Emulsions', parentId: null, isActive: true },
        }),
      ),
    ).toEqual({
      brandId: 'brand-asian',
      categoryId: 'cat-emulsion',
      name: 'Apex Ultima',
      type: 'exterior_paint',
      description: 'Tough',
      hsnCode: '3209',
      gstRatePercent: '18',
      isActive: true,
      variants: [],
    });
  });
});

describe('NewProductPage', () => {
  it('creates a product with several pack sizes', async () => {
    let body: unknown;
    const { user } = renderForm('/products/new', {
      'POST /products': (request) => {
        body = request.body;
        return json(product({ id: 'product-new', name: 'Tractor Emulsion' }), 201);
      },
    });
    expect(await screen.findByRole('heading', { name: 'New product', level: 1 })).toBeVisible();
    const brand = await screen.findByRole('combobox', { name: 'Brand' });
    // Inactive brands are not offered for new products.
    expect(within(brand).queryByRole('option', { name: 'Old Brand' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add product' }));
    expect(screen.getByText('This is required')).toBeInTheDocument();
    expect(screen.getByText('Use 2 to 120 characters')).toBeInTheDocument();

    await user.selectOptions(brand, 'Asian Paints');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'Emulsions');
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Tractor Emulsion');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'Interior paint');
    await user.selectOptions(screen.getByRole('combobox', { name: 'GST rate' }), '28%');
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Smooth finish');
    const first = screen.getByRole('group', { name: 'Pack size 1' });
    await user.type(within(first).getByRole('textbox', { name: 'SKU' }), 'tr-1l');
    await user.type(within(first).getByRole('textbox', { name: 'Size' }), '1');
    await user.type(within(first).getByRole('textbox', { name: 'MRP (₹)' }), '300');

    await user.click(screen.getByRole('button', { name: 'Add another pack size' }));
    const second = screen.getByRole('group', { name: 'Pack size 2' });
    await user.type(within(second).getByRole('textbox', { name: 'SKU' }), 'TR-4L');
    await user.type(within(second).getByRole('textbox', { name: 'Size' }), '4');
    await user.selectOptions(within(second).getByRole('combobox', { name: 'Unit' }), 'kg');
    await user.type(within(second).getByRole('textbox', { name: 'Barcodes' }), '8901234567890');
    await user.click(screen.getByRole('button', { name: 'Add another pack size' }));
    await user.click(screen.getByRole('button', { name: 'Remove pack size 3' }));
    expect(screen.queryByRole('group', { name: 'Pack size 3' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Add product' }));
    await waitFor(() => {
      expect(location()).toBe('/products/product-new');
    });
    expect(body).toEqual({
      brandId: 'brand-asian',
      categoryId: 'cat-emulsion',
      name: 'Tractor Emulsion',
      type: 'interior_paint',
      hsnCode: '3209',
      gstRatePercent: 28,
      description: 'Smooth finish',
      variants: [
        { sku: 'TR-1L', packSize: 1, unit: 'l', mrpPaise: 30_000, barcodes: [] },
        { sku: 'TR-4L', packSize: 4, unit: 'kg', barcodes: ['8901234567890'] },
      ],
    });
    expect(await screen.findByText('Product added')).toBeInTheDocument();
  });

  it('shows API problems next to their fields, or above the form', async () => {
    let attempts = 0;
    const { user } = renderForm('/products/new', {
      'GET /brands': () => json(BRANDS.slice(0, 1)),
      'POST /products': () => {
        attempts += 1;
        return attempts === 1
          ? json(
              {
                message: 'Validation failed',
                issues: [{ path: 'name', message: 'A product with this name exists' }],
              },
              400,
            )
          : json({ message: 'SKU TR-1L is already in use' }, 409);
      },
    });
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Brand' }),
      'Asian Paints',
    );
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Apex Ultima');
    await user.type(screen.getByRole('textbox', { name: 'SKU' }), 'TR-1L');
    await user.type(screen.getByRole('textbox', { name: 'Size' }), '1');
    await user.click(screen.getByRole('button', { name: 'Add product' }));
    expect(await screen.findByText('A product with this name exists')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add product' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('SKU TR-1L is already in use');
  });

  it('asks for a brand first when there is none', async () => {
    renderForm('/products/new', { 'GET /brands': () => json([]) });
    expect(
      await screen.findByText('Add a brand first under Brands & categories'),
    ).toBeInTheDocument();
  });
});

describe('EditProductPage', () => {
  it('saves changes to the product family', async () => {
    let body: unknown;
    const { user } = renderForm('/products/product-apex/edit', {
      'GET /products/:id': () =>
        json(product({ brand: { id: 'brand-old', name: 'Old Brand' }, description: 'Old text' })),
      'PATCH /products/:id': (request) => {
        body = request.body;
        return json(APEX);
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Edit Apex Ultima', level: 1 }),
    ).toBeVisible();
    // The product's own brand stays available even though it is inactive.
    expect(await screen.findByRole('combobox', { name: 'Brand' })).toHaveDisplayValue('Old Brand');
    expect(screen.queryByRole('group', { name: 'Pack size 1' })).toBeNull();
    await user.clear(screen.getByRole('textbox', { name: 'Description' }));
    await user.click(screen.getByRole('checkbox', { name: 'Active' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(location()).toBe('/products/product-apex');
    });
    expect(body).toEqual({
      brandId: 'brand-old',
      name: 'Apex Ultima',
      type: 'exterior_paint',
      hsnCode: '3209',
      gstRatePercent: 18,
      categoryId: null,
      description: null,
      isActive: false,
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('checks the HSN code', async () => {
    const { user } = renderForm('/products/product-apex/edit');
    const hsn = await screen.findByRole('textbox', { name: 'HSN code' });
    await user.clear(hsn);
    await user.type(hsn, '12');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a 4, 6 or 8-digit HSN code')).toBeInTheDocument();
  });

  it('says when the product cannot be loaded', async () => {
    renderForm('/products/missing/edit', {
      'GET /products/:id': () => json({ message: 'Product not found' }, 404),
    });
    expect(await screen.findByText('Could not load this product')).toBeInTheDocument();
  });
});
