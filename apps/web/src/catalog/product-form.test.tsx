import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import {
  APEX,
  BRANDS,
  CATEGORIES,
  product,
  TAX_OPTIONS,
} from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { initialValues, isValidCoverage } from './ProductFormPage.js';

const location = () => screen.getByTestId('location').textContent;

function renderForm(path: string, routes: Record<string, FakeHandler> = {}) {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(OWNER),
      'GET /brands': () => json(BRANDS),
      'GET /categories': () => json(CATEGORIES),
      'GET /tax-categories/options': () => json(TAX_OPTIONS),
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
      taxCategoryId: '',
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
      taxCategoryId: 'tax-paints',
      isActive: true,
      coverage: '',
      defaultCoats: '',
      isTintable: false,
      variants: [],
    });
    expect(
      initialValues(product({ coverageSqftPerLitre: 129.17, defaultCoats: 2, isTintable: true })),
    ).toMatchObject({ coverage: '129.17', defaultCoats: '2', isTintable: true });
  });
});

describe('isValidCoverage', () => {
  it('takes blank (hardware) or sq ft above zero with at most 2 decimals', () => {
    expect(isValidCoverage('  ')).toBe(true);
    expect(isValidCoverage('120')).toBe(true);
    expect(isValidCoverage('9999.99')).toBe(true);
    expect(isValidCoverage('0')).toBe(false);
    expect(isValidCoverage('10000')).toBe(false);
    expect(isValidCoverage('120.125')).toBe(false);
    expect(isValidCoverage('a lot')).toBe(false);
  });
});

describe('paint details', () => {
  it('saves coverage, coats and tintable with a new paint', async () => {
    let body: unknown;
    const { user } = renderForm('/products/new', {
      'POST /products': (request) => {
        body = request.body;
        return json(product({ id: 'product-new' }), 201);
      },
    });
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Brand' }),
      'Asian Paints',
    );
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Royale');
    const coverage = screen.getByRole('textbox', { name: 'Coverage (sq ft per litre, one coat)' });
    await user.type(coverage, '0');
    await user.type(screen.getByRole('textbox', { name: 'SKU' }), 'RY-4L');
    await user.type(screen.getByRole('textbox', { name: 'Size' }), '4');
    await user.click(screen.getByRole('button', { name: 'Add product' }));
    expect(
      await screen.findByText('Enter sq ft above zero, up to 9,999.99, with at most 2 decimals'),
    ).toBeInTheDocument();

    await user.clear(coverage);
    await user.type(coverage, '140.5');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Default coats' }), '3');
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Tintable base: shades are mixed into it at the counter',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Add product' }));
    await waitFor(() => {
      expect(body).toMatchObject({
        name: 'Royale',
        coverageSqftPerLitre: 140.5,
        defaultCoats: 3,
        isTintable: true,
      });
    });
  });

  it('clears them when a product turns out to be hardware', async () => {
    let body: unknown;
    const { user } = renderForm('/products/product-apex/edit', {
      'GET /products/:id': () =>
        json(product({ coverageSqftPerLitre: 120, defaultCoats: 2, isTintable: true })),
      'PATCH /products/:id': (request) => {
        body = request.body;
        return json(APEX);
      },
    });
    const coverage = await screen.findByRole('textbox', {
      name: 'Coverage (sq ft per litre, one coat)',
    });
    expect(coverage).toHaveValue('120');
    expect(screen.getByRole('combobox', { name: 'Default coats' })).toHaveDisplayValue('2');
    await user.clear(coverage);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Default coats' }), 'Not set');
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Tintable base: shades are mixed into it at the counter',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(body).toMatchObject({
        coverageSqftPerLitre: null,
        defaultCoats: null,
        isTintable: false,
      });
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
    const tax = screen.getByRole('combobox', { name: 'Tax category' });
    expect(tax).toHaveDisplayValue('Default (Paints 18%)');
    // user-event matches an option's HTML, where & is &amp;; pick it by value.
    await user.selectOptions(tax, 'tax-putty');
    expect(screen.getByText('GST 18% today')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Smooth finish');
    const first = screen.getByRole('group', { name: 'Size / pack 1' });
    await user.type(within(first).getByRole('textbox', { name: 'SKU' }), 'tr-1l');
    await user.type(within(first).getByRole('textbox', { name: 'Size' }), '1');
    await user.type(within(first).getByRole('textbox', { name: 'MRP (₹)' }), '300');

    await user.click(screen.getByRole('button', { name: 'Add another size / pack' }));
    const second = screen.getByRole('group', { name: 'Size / pack 2' });
    await user.type(within(second).getByRole('textbox', { name: 'SKU' }), 'TR-4L');
    await user.type(within(second).getByRole('textbox', { name: 'Size' }), '4');
    await user.selectOptions(within(second).getByRole('combobox', { name: 'Unit' }), 'kg');
    await user.type(within(second).getByRole('textbox', { name: 'Label' }), 'Grit 120');
    await user.type(within(second).getByRole('textbox', { name: 'Barcodes' }), '8901234567890');
    await user.click(screen.getByRole('button', { name: 'Add another size / pack' }));
    await user.click(screen.getByRole('button', { name: 'Remove size / pack 3' }));
    expect(screen.queryByRole('group', { name: 'Size / pack 3' })).toBeNull();

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
      taxCategoryId: 'tax-putty',
      description: 'Smooth finish',
      variants: [
        { sku: 'TR-1L', packSize: 1, unit: 'l', label: null, mrpPaise: 30_000, barcodes: [] },
        {
          sku: 'TR-4L',
          packSize: 4,
          unit: 'kg',
          label: 'Grit 120',
          barcodes: ['8901234567890'],
        },
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
    expect(screen.queryByRole('group', { name: 'Size / pack 1' })).toBeNull();
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
      categoryId: null,
      description: null,
      coverageSqftPerLitre: null,
      defaultCoats: null,
      isTintable: false,
      isActive: false,
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('offers only categories that take new products, keeping the product’s own', async () => {
    const categories = [
      ...CATEGORIES,
      { id: 'cat-primer', name: 'Primers', parentId: null, isActive: false },
      { id: 'cat-wall', name: 'Wall primers', parentId: 'cat-primer', isActive: true },
    ];
    const options = async () =>
      within(await screen.findByRole('combobox', { name: 'Category' }))
        .getAllByRole('option')
        .map((option) => option.textContent);
    const view = renderForm('/products/new', { 'GET /categories': () => json(categories) });
    expect(await options()).toEqual(['No category', 'Emulsions', 'Emulsions › Interior emulsions']);
    view.unmount();

    renderForm('/products/product-apex/edit', {
      'GET /categories': () => json(categories),
      'GET /products/:id': () => json(product({ category: categories[3] ?? null })),
    });
    await screen.findByRole('heading', { name: 'Edit Apex Ultima', level: 1 });
    expect(await options()).toEqual([
      'No category',
      'Emulsions',
      'Emulsions › Interior emulsions',
      'Primers › Wall primers',
    ]);
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveDisplayValue(
      'Primers › Wall primers',
    );
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

describe('tax category', () => {
  it('must be chosen for a new product once the business is registered for GST', async () => {
    let body: unknown;
    const { user } = renderForm('/products/new', {
      'GET /tax-categories/options': () => json({ ...TAX_OPTIONS, gstRegistered: true }),
      'POST /products': (request) => {
        body = request.body;
        return json(product({ id: 'product-new' }), 201);
      },
    });
    const tax = await screen.findByRole('combobox', { name: /Tax category/ });
    expect(tax).toHaveDisplayValue('Choose a tax category');
    await user.click(screen.getByRole('button', { name: 'Add product' }));
    expect(
      screen.getByText('Choose a tax category: the business is registered for GST'),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Brand' }), 'Asian Paints');
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Wall Putty');
    await user.selectOptions(tax, 'Starts later 5%');
    // A category whose first rate starts later has no rate today.
    expect(screen.queryByText(/today/)).toBeNull();
    const first = screen.getByRole('group', { name: 'Size / pack 1' });
    await user.type(within(first).getByRole('textbox', { name: 'SKU' }), 'WP-1');
    await user.type(within(first).getByRole('textbox', { name: 'Size' }), '1');
    await user.click(screen.getByRole('button', { name: 'Add product' }));
    await waitFor(() => {
      expect(body).toMatchObject({ taxCategoryId: 'tax-later' });
    });
  });

  it('offers no default without one, and keeps an existing product’s inactive category', async () => {
    const view = renderForm('/products/new', {
      'GET /tax-categories/options': () =>
        json({ gstRegistered: false, categories: TAX_OPTIONS.categories.slice(1) }),
    });
    expect(await screen.findByRole('combobox', { name: 'Tax category' })).toHaveDisplayValue(
      'Choose a tax category',
    );
    view.unmount();

    let body: unknown;
    const { user } = renderForm('/products/product-apex/edit', {
      'GET /products/:id': () => json(product({ taxCategory: { id: 'tax-old', name: 'Old 12%' } })),
      'PATCH /products/:id': (request) => {
        body = request.body;
        return json(product());
      },
    });
    const tax = await screen.findByRole('combobox', { name: 'Tax category' });
    expect(
      within(tax)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Paints 18%', 'Putty & fillers 18%', 'Starts later 5%', 'Old 12%']);
    expect(tax).toHaveDisplayValue('Old 12%');
    await user.selectOptions(tax, 'Paints 18%');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(body).toMatchObject({ taxCategoryId: 'tax-paints' });
    });
  });
});
