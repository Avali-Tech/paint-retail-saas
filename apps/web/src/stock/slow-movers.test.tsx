import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SlowMover } from '../api/stock.js';
import { CASHIER, OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { STORES, page } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';

const slow = (overrides: Partial<SlowMover> = {}): SlowMover => ({
  store: { id: 'store-hyd', code: 'HYD' },
  variant: { id: 'variant-20l', sku: 'APX-20L', packSize: 20, unit: 'l', label: null },
  product: { name: 'Apex Ultima' },
  brand: { name: 'Asian Paints' },
  onHand: 6,
  lastDemandAt: '2026-08-01T06:30:00.000Z',
  daysIdle: 81,
  valuePaise: 4_200_000,
  productId: 'product-apex',
  sellsAt: { store: { id: 'store-pun', code: 'PUN', name: 'Pune' }, soldQuantity: 4 },
  ...overrides,
});

const OLD_STOCK = slow();

const ITEMS = [
  OLD_STOCK,
  slow({
    variant: { id: 'variant-texture', sku: 'TEX-5K', packSize: 5, unit: 'kg', label: 'Sand' },
    product: { name: 'Royale Play' },
    onHand: 3,
    lastDemandAt: null,
    daysIdle: 1,
    valuePaise: null,
    sellsAt: null,
  }),
];

function renderSlow(
  routes: Record<string, FakeHandler> = {},
  { member = OWNER, path = '/stock/slow-movers' } = {},
) {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(member),
      'GET /stores': () => json(STORES),
      'GET /stock/slow-movers': () => json(page(ITEMS, 2)),
      ...routes,
    },
  });
}

describe('SlowMoversPage', () => {
  it('lists idle stock with the money tied up, 45 days by default', async () => {
    const { requests } = renderSlow();
    const table = await screen.findByRole('table', { name: 'Slow-moving items' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      'ProductStoreOn handIdle forLast sold or sentSells atMoney tied up',
      'Asian Paints Apex UltimaAPX-20L · 20 lHYD681 days1 Aug 2026PUN: 4 soldMove to PUN₹42,000.00',
      'Asian Paints Royale PlayTEX-5K · Sand · 5 kgHYD31 dayNeverNot selling elsewhere eitherNo cost',
    ]);
    expect(screen.getByText('2 items have not moved in 45 days')).toBeInTheDocument();
    const query = requests.find((request) => request.path === '/stock/slow-movers')?.query;
    expect(query?.get('days')).toBe('45');
    expect(query?.get('storeId')).toBeNull();
    expect(screen.getByRole('link', { name: 'New transfer' })).toHaveAttribute(
      'href',
      '/transfers/new',
    );
    // Straight to a request from where it sits to where it sells.
    expect(screen.getByRole('link', { name: 'Move to PUN' })).toHaveAttribute(
      'href',
      '/transfers/new?from=store-hyd&to=store-pun&product=product-apex&variant=variant-20l&quantity=6',
    );
  });

  it('asks again for another store and window, keeping them in the address', async () => {
    const { user, requests } = renderSlow({
      'GET /stock/slow-movers': () => json(page([OLD_STOCK], 1)),
    });
    await screen.findByRole('table', { name: 'Slow-moving items' });
    expect(screen.getByText('1 item has not moved in 45 days')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Not moved for' }), '90 days');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'HYD · Hyderabad');
    await waitFor(() => {
      const last = requests.filter((request) => request.path === '/stock/slow-movers').at(-1);
      expect(last?.query.get('days')).toBe('90');
      expect(last?.query.get('storeId')).toBe('store-hyd');
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Not moved for' }), '45 days');
    await waitFor(() => {
      const last = requests.filter((request) => request.path === '/stock/slow-movers').at(-1);
      expect(last?.query.get('days')).toBe('45');
    });
  });

  it('falls back to 45 days for a window it does not offer', async () => {
    const { requests } = renderSlow({}, { path: '/stock/slow-movers?days=7' });
    await screen.findByRole('table', { name: 'Slow-moving items' });
    expect(
      requests.find((request) => request.path === '/stock/slow-movers')?.query.get('days'),
    ).toBe('45');
  });

  it('says when everything is moving, and hides the transfer link from read-only staff', async () => {
    renderSlow(
      { 'GET /stock/slow-movers': () => json(page([])) },
      { member: CASHIER, path: '/stock/slow-movers?days=180' },
    );
    expect(await screen.findByText('Everything is moving')).toBeInTheDocument();
    expect(
      screen.getByText('No stock has gone 180 days without a sale or a transfer out.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New transfer' })).toBeNull();
  });

  it('hides the transfer link from staff who cannot move stock, and the money from those who cannot see costs', async () => {
    renderSlow({}, { member: CASHIER });
    const table = await screen.findByRole('table', { name: 'Slow-moving items' });
    expect(screen.queryByRole('link', { name: 'New transfer' })).toBeNull();
    expect(within(table).queryByRole('columnheader', { name: /tied up/i })).toBeNull();
    expect(within(table).getByText('PUN: 4 sold')).toBeInTheDocument();
    expect(within(table).queryByRole('link', { name: 'Move to PUN' })).toBeNull();
  });

  it('pages through a long list', async () => {
    const { user, requests } = renderSlow({
      'GET /stock/slow-movers': () => json(page(ITEMS, 250)),
    });
    const pages = await screen.findByRole('navigation', { name: 'Slow mover pages' });
    expect(within(pages).getByText('1–100 of 250')).toBeInTheDocument();
    await user.click(within(pages).getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(
        requests
          .filter((request) => request.path === '/stock/slow-movers')
          .at(-1)
          ?.query.get('offset'),
      ).toBe('100');
    });
  });

  it('says when the list cannot load', async () => {
    renderSlow({ 'GET /stock/slow-movers': () => json({ message: 'Down' }, 500) });
    expect(await screen.findByText('Could not load slow movers')).toBeInTheDocument();
  });
});
