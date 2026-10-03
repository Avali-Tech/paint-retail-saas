import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CASHIER, OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { STORES, page, stockRow } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { PAGE_SIZE } from './StockPage.js';

const location = () => screen.getByTestId('location').textContent;

function renderStock(
  routes: Record<string, FakeHandler> = {},
  { member = OWNER, path = '/stock' } = {},
) {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(member),
      'GET /stores': () => json(STORES),
      'GET /stock': () =>
        json(
          page([
            stockRow(),
            stockRow({
              valuePaise: null,
              avgCostPaise: null,
              store: { id: 'store-pun', code: 'PUN', name: 'Pune' },
            }),
          ]),
        ),
      ...routes,
    },
  });
}

describe('StockPage', () => {
  it('shows on hand, reserved, available and value per store', async () => {
    renderStock();
    const table = await screen.findByRole('table', { name: 'Stock balances' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      'ProductStoreOn handReservedAvailableValue',
      'Asian Paints Apex UltimaAPX-1L · 1 lHYD12210₹4,800.00',
      'Asian Paints Apex UltimaAPX-1L · 1 lPUN12210—',
    ]);
    expect(
      within(table).getAllByRole('link', { name: 'Asian Paints Apex Ultima' })[0],
    ).toHaveAttribute('href', '/products/product-apex');
    const sections = screen.getByRole('navigation', { name: 'Stock sections' });
    expect(
      within(sections)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Balances', 'Low stock', 'Reorder rules', 'Transfers', 'Stock counts']);
    expect(within(sections).getByRole('link', { name: 'Balances' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Record movement' })).toHaveAttribute(
      'href',
      '/stock/movements/new',
    );
    expect(screen.getByRole('link', { name: 'Import from a spreadsheet' })).toHaveAttribute(
      'href',
      '/imports?kind=opening-stock',
    );
  });

  it('filters by store, search and in-stock items, in the address', async () => {
    const { user, requests } = renderStock();
    await screen.findByRole('table', { name: 'Stock balances' });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'PUN · Pune' })).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'PUN · Pune');
    await user.click(screen.getByRole('checkbox', { name: 'Only items in stock' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search by product or SKU' }), 'apx');
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('q')).toBe('apx');
    });
    expect(Object.fromEntries(requests.at(-1)?.query ?? [])).toEqual({
      storeId: 'store-pun',
      q: 'apx',
      inStockOnly: 'true',
      limit: String(PAGE_SIZE),
      offset: '0',
    });
    expect(location()).toBe('/stock?store=store-pun&inStock=1&q=apx');
    // Recording a movement starts at the chosen store.
    expect(screen.getByRole('link', { name: 'Record movement' })).toHaveAttribute(
      'href',
      '/stock/movements/new?store=store-pun',
    );
    await user.click(screen.getByRole('checkbox', { name: 'Only items in stock' }));
    expect(location()).toBe('/stock?store=store-pun&q=apx');
  });

  it('says when there is no stock yet, or nothing matches', async () => {
    renderStock({ 'GET /stock': () => json(page([])) });
    expect(await screen.findByText('No stock yet')).toBeInTheDocument();
    expect(
      screen.getByText('Record opening stock or receive goods to see balances here.'),
    ).toBeInTheDocument();
  });

  it('says when nothing matches the filters', async () => {
    renderStock({ 'GET /stock': () => json(page([])) }, { path: '/stock?inStock=1' });
    expect(await screen.findByText('Nothing matches these filters')).toBeInTheDocument();
  });

  it('pages through long lists', async () => {
    const { user } = renderStock({ 'GET /stock': () => json(page([stockRow()], 75)) });
    const pages = await screen.findByRole('navigation', { name: 'Stock pages' });
    await user.click(within(pages).getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(location()).toBe('/stock?offset=50');
    });
  });

  it('still filters by a closed store, whose history is worth seeing', async () => {
    renderStock({ 'GET /stores': () => json([STORES[0], { ...STORES[1], isActive: false }]) });
    expect(await screen.findByRole('option', { name: 'PUN · Pune' })).toBeInTheDocument();
  });

  it('is read-only for staff who cannot change stock', async () => {
    renderStock({}, { member: CASHIER });
    await screen.findByRole('table', { name: 'Stock balances' });
    expect(screen.queryByRole('link', { name: 'Record movement' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Import from a spreadsheet' })).toBeNull();
  });

  it('shows a loading problem', async () => {
    renderStock({ 'GET /stock': () => json({ message: 'Down' }, 503) });
    expect(await screen.findByText('Could not load stock')).toBeInTheDocument();
  });
});
