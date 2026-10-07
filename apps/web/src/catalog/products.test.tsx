import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Product } from '../api/catalog.js';
import { createI18n } from '../i18n/i18n.js';
import { CASHIER, OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import {
  APEX,
  BRANDS,
  CATEGORIES,
  page,
  product,
  variant,
} from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { PAGE_SIZE, priceRange, sellable } from './ProductsPage.js';

const location = () => screen.getByTestId('location').textContent;

function renderProducts(
  routes: Record<string, FakeHandler> = {},
  { member = OWNER, path = '/products' } = {},
) {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(member),
      'GET /brands': () => json(BRANDS),
      'GET /categories': () => json(CATEGORIES),
      'GET /products': () => json(page([APEX])),
      'GET /products/:id': () => json(APEX),
      ...routes,
    },
  });
}

describe('sellable', () => {
  it('keeps the pack sizes on sale, or all of a product no longer sold', () => {
    const old = variant({ id: 'old', sku: 'APX-OLD', isActive: false });
    expect(sellable(product({ variants: [variant(), old] })).map((item) => item.sku)).toEqual([
      'APX-1L',
    ]);
    expect(sellable(product({ variants: [old] })).map((item) => item.sku)).toEqual(['APX-OLD']);
  });
});

describe('priceRange', () => {
  const { money } = createI18n('en');
  it('spans the selling prices (or MRPs) of the pack sizes', () => {
    expect(priceRange(APEX, money)).toBe('₹450.00 – ₹1,700.00');
    expect(priceRange(product({ variants: [variant()] }), money)).toBe('₹450.00');
    expect(
      priceRange(
        product({ variants: [variant({ mrpPaise: null, sellingPricePaise: null })] }),
        money,
      ),
    ).toBeNull();
  });
});

describe('ProductsPage', () => {
  it('lists products with their pack sizes and prices', async () => {
    const inactive: Product = product({
      id: 'product-old',
      name: 'Old Enamel',
      isActive: false,
      variants: [
        variant({ mrpPaise: null, sellingPricePaise: null }),
        variant({
          id: 'v-red',
          sku: 'OE-RED',
          label: 'Red',
          mrpPaise: null,
          sellingPricePaise: null,
        }),
      ],
    });
    renderProducts({ 'GET /products': () => json(page([APEX, inactive])) });
    const table = await screen.findByRole('table', { name: 'Products' });
    const rows = within(table).getAllByRole('row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'ProductBrandTypeSizes / packsPrice',
      'Apex UltimaAsian PaintsExterior paint1 l, 4 l₹450.00 – ₹1,700.00',
      'Old Enamel InactiveAsian PaintsExterior paint1 l, Red · 1 l—',
    ]);
    expect(screen.getByRole('link', { name: '+ Product' })).toHaveAttribute(
      'href',
      '/products/new',
    );
    expect(screen.getByRole('link', { name: 'Import from a spreadsheet' })).toHaveAttribute(
      'href',
      '/imports?kind=products',
    );
    expect(screen.queryByRole('navigation', { name: 'Product pages' })).toBeNull();
  });

  it('keeps filters in the address and sends them to the API', async () => {
    const { user, requests } = renderProducts();
    await screen.findByRole('table', { name: 'Products' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Brand' }), 'Asian Paints');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'Emulsions');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'Primer');
    await user.click(screen.getByRole('checkbox', { name: 'Show inactive' }));
    await user.type(
      screen.getByRole('searchbox', { name: 'Search by name, brand, SKU or label' }),
      'apex',
    );
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('q')).toBe('apex');
    });
    const last = requests.filter((request) => request.path === '/products').at(-1);
    expect(Object.fromEntries(last?.query ?? [])).toEqual({
      q: 'apex',
      brandId: 'brand-asian',
      categoryId: 'cat-emulsion',
      type: 'primer',
      includeInactive: 'true',
      limit: String(PAGE_SIZE),
      offset: '0',
    });
    expect(location()).toBe(
      '/products?brand=brand-asian&category=cat-emulsion&type=primer&inactive=1&q=apex',
    );
    await user.click(screen.getByRole('checkbox', { name: 'Show inactive' }));
    expect(location()).not.toContain('inactive');
  });

  it('says when there are no products, or none match', async () => {
    renderProducts({ 'GET /products': () => json(page([])) });
    expect(await screen.findByText('No products yet')).toBeInTheDocument();
    expect(
      screen.getByText('Add brands, then products with their pack sizes and prices.'),
    ).toBeInTheDocument();
  });

  it('says when nothing matches the filters', async () => {
    renderProducts({ 'GET /products': () => json(page([])) }, { path: '/products?type=primer' });
    expect(await screen.findByText('No products match these filters')).toBeInTheDocument();
  });

  it('pages through a long catalogue', async () => {
    const { user, requests } = renderProducts({
      'GET /products': () => json(page([APEX], 120)),
    });
    const pages = await screen.findByRole('navigation', { name: 'Product pages' });
    expect(pages).toHaveTextContent('1–50 of 120');
    await user.click(within(pages).getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(location()).toBe('/products?offset=50');
    });
    expect(requests.at(-1)?.query.get('offset')).toBe('50');
  });

  it('shows the error with a retry', async () => {
    let calls = 0;
    const { user } = renderProducts({
      'GET /products': () => {
        calls += 1;
        return calls === 1 ? json({ message: 'Database is down' }, 503) : json(page([APEX]));
      },
    });
    expect(await screen.findByText('Database is down')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Products' })).toBeInTheDocument();
  });

  it('hides adding products from staff who cannot manage the catalogue', async () => {
    renderProducts({}, { member: CASHIER });
    await screen.findByRole('table', { name: 'Products' });
    expect(screen.queryByRole('link', { name: '+ Product' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Import from a spreadsheet' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Brands & categories' })).toBeInTheDocument();
  });
});

describe('barcode lookup', () => {
  it('opens the product of a scanned barcode', async () => {
    const { user, requests } = renderProducts({
      'GET /products/lookup': () => json({ product: APEX, variant: APEX.variants[0] }),
    });
    const box = await screen.findByRole('searchbox', { name: 'Barcode or SKU' });
    await user.click(screen.getByRole('button', { name: 'Find' }));
    expect(requests.some((request) => request.path === '/products/lookup')).toBe(false);
    await user.type(box, '8901234567890{Enter}');
    expect(await screen.findByRole('heading', { name: 'Apex Ultima', level: 1 })).toBeVisible();
    expect(location()).toBe('/products/product-apex');
    expect(requests.find((request) => request.path === '/products/lookup')?.query.get('code')).toBe(
      '8901234567890',
    );
  });

  it('says when no product has the code, or the lookup fails', async () => {
    let calls = 0;
    const { user } = renderProducts({
      'GET /products/lookup': () => {
        calls += 1;
        return calls === 1
          ? json({ message: 'Not Found' }, 404)
          : json({ message: 'Server error' }, 500);
      },
    });
    const box = await screen.findByRole('searchbox', { name: 'Barcode or SKU' });
    await user.type(box, 'NOPE{Enter}');
    expect(await screen.findByText('No product has the code “NOPE”')).toBeInTheDocument();
    expect(box).toHaveAccessibleDescription(/No product has the code/);
    await user.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByText('Server error')).toBeInTheDocument();
  });
});
