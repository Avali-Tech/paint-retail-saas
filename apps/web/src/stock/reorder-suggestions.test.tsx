import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReorderSuggestion } from '../api/stock.js';
import { CASHIER, OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { STORES, page } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';

const suggestion = (overrides: Partial<ReorderSuggestion> = {}): ReorderSuggestion => ({
  store: { id: 'store-hyd', code: 'HYD' },
  variant: { id: 'variant-1l', sku: 'APX-1L', packSize: 1, unit: 'l', label: null },
  product: { name: 'Apex Ultima' },
  brand: { name: 'Asian Paints' },
  soldQuantity: 90,
  dailyRate: 1,
  leadTimeDays: 5,
  supplierName: 'Shah Distributors',
  current: { minQuantity: 2, reorderLevel: 4, maxQuantity: 10 },
  suggested: { minQuantity: 5, reorderLevel: 12, maxQuantity: 42 },
  ...overrides,
});

const FAST = suggestion();
const STEADY = suggestion({
  variant: { id: 'variant-4l', sku: 'APX-4L', packSize: 4, unit: 'l', label: null },
  soldQuantity: 2,
  dailyRate: 0.022,
  leadTimeDays: 7,
  supplierName: null,
  current: { minQuantity: 1, reorderLevel: 1, maxQuantity: 2 },
  suggested: { minQuantity: 1, reorderLevel: 1, maxQuantity: 2 },
});
const NEW = suggestion({
  variant: { id: 'variant-20l', sku: 'APX-20L', packSize: 20, unit: 'l', label: null },
  current: null,
});

function renderSuggestions(
  routes: Record<string, FakeHandler> = {},
  { member = OWNER, path = '/stock/reorder-rules/suggestions?store=store-hyd' } = {},
) {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(member),
      'GET /stores': () => json(STORES),
      'GET /reorder-rules/suggestions': () => json(page([FAST, STEADY, NEW])),
      ...routes,
    },
  });
}

const lastQuery = (requests: readonly { path: string; query: URLSearchParams }[]) =>
  requests.filter((request) => request.path === '/reorder-rules/suggestions').at(-1)?.query;

describe('ReorderSuggestionsPage', () => {
  it('compares each product’s level now with what its sales suggest', async () => {
    const { requests } = renderSuggestions();
    const table = await screen.findByRole('table', { name: 'Suggested reorder levels' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      'SelectProductSoldPer dayLead timeNow (min / reorder / max)Suggested (min / reorder / max)',
      'Asian Paints Apex UltimaAPX-1L · 1 l9015 daysShah Distributors2 / 4 / 105 / 12 / 42',
      'Asian Paints Apex UltimaAPX-4L · 4 l20.027 daysNo supplier lead time: default used1 / 1 / 21 / 1 / 2Same as now',
      'Asian Paints Apex UltimaAPX-20L · 20 l9015 daysShah DistributorsNo rule5 / 12 / 42',
    ]);
    expect(
      screen.getByText(
        'From the last 90 days of sales and each supplier’s lead time, plus 7 days of safety stock',
      ),
    ).toBeInTheDocument();
    const query = lastQuery(requests);
    expect([query?.get('storeId'), query?.get('days'), query?.get('safetyDays')]).toEqual([
      'store-hyd',
      '90',
      '7',
    ]);
  });

  it('applies the chosen suggestions as reorder rules', async () => {
    let body: unknown;
    const { user } = renderSuggestions({
      'PUT /reorder-rules': (request) => {
        body = request.body;
        return json({ saved: 2 });
      },
    });
    const apply = await screen.findByRole('button', { name: 'Apply 0 suggestions' });
    expect(apply).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Select APX-1L' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select APX-4L' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select APX-4L' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select APX-20L' }));
    await user.click(screen.getByRole('button', { name: 'Apply 2 suggestions' }));
    expect(await screen.findByText('2 reorder rules saved')).toBeInTheDocument();
    expect(body).toEqual({
      rules: [
        {
          storeId: 'store-hyd',
          variantId: 'variant-1l',
          minQuantity: 5,
          reorderLevel: 12,
          maxQuantity: 42,
        },
        {
          storeId: 'store-hyd',
          variantId: 'variant-20l',
          minQuantity: 5,
          reorderLevel: 12,
          maxQuantity: 42,
        },
      ],
    });
    expect(screen.getByRole('button', { name: 'Apply 0 suggestions' })).toBeDisabled();
  });

  it('says why saving failed', async () => {
    const { user } = renderSuggestions({
      'PUT /reorder-rules': () => json({ message: 'Use minimum ≤ reorder level ≤ maximum' }, 400),
    });
    await user.click(await screen.findByRole('checkbox', { name: 'Select APX-1L' }));
    await user.click(screen.getByRole('button', { name: 'Apply 1 suggestion' }));
    expect(await screen.findByText('Use minimum ≤ reorder level ≤ maximum')).toBeInTheDocument();
  });

  it('asks again for another window and safety margin', async () => {
    const { user, requests } = renderSuggestions();
    await screen.findByRole('table', { name: 'Suggested reorder levels' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sales over' }), '30 days');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Safety stock' }), '0 days');
    await waitFor(() => {
      const query = lastQuery(requests);
      expect([query?.get('days'), query?.get('safetyDays')]).toEqual(['30', '0']);
    });
    expect(
      screen.getByText(
        'From the last 30 days of sales and each supplier’s lead time, plus 0 days of safety stock',
      ),
    ).toBeInTheDocument();
  });

  it('falls back to 90 days and 7 days of safety for values it does not offer', async () => {
    const { requests } = renderSuggestions(
      {},
      { path: '/stock/reorder-rules/suggestions?store=store-hyd&days=5&safety=' },
    );
    await screen.findByRole('table', { name: 'Suggested reorder levels' });
    const query = lastQuery(requests);
    expect([query?.get('days'), query?.get('safetyDays')]).toEqual(['90', '7']);
  });

  it('asks for a store first, and asks for nothing until then', async () => {
    const { user, requests } = renderSuggestions({}, { path: '/stock/reorder-rules/suggestions' });
    expect(
      await screen.findByText('Reorder levels are per store: choose one above.'),
    ).toBeInTheDocument();
    expect(lastQuery(requests)).toBeUndefined();
    await screen.findByRole('option', { name: 'HYD · Hyderabad' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'HYD · Hyderabad');
    expect(await screen.findByRole('table', { name: 'Suggested reorder levels' })).toBeVisible();
  });

  it('shows suggestions without the apply controls to staff who cannot change rules', async () => {
    renderSuggestions({}, { member: CASHIER });
    const table = await screen.findByRole('table', { name: 'Suggested reorder levels' });
    expect(within(table).queryAllByRole('checkbox')).toEqual([]);
    expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
  });

  it('says when nothing sold, and when it cannot load', async () => {
    renderSuggestions({ 'GET /reorder-rules/suggestions': () => json(page([])) });
    expect(await screen.findByText('Nothing sold yet')).toBeInTheDocument();
    expect(screen.getByText('Nothing sold at this store in the last 90 days.')).toBeInTheDocument();
  });

  it('pages through a long list', async () => {
    const { user, requests } = renderSuggestions({
      'GET /reorder-rules/suggestions': () => json(page([FAST], 240)),
    });
    const pages = await screen.findByRole('navigation', { name: 'Suggestion pages' });
    expect(within(pages).getByText('1–100 of 240')).toBeInTheDocument();
    await user.click(within(pages).getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(lastQuery(requests)?.get('offset')).toBe('100');
    });
  });

  it('says when it cannot work them out', async () => {
    renderSuggestions({ 'GET /reorder-rules/suggestions': () => json({ message: 'Down' }, 500) });
    expect(await screen.findByText('Could not work out suggestions')).toBeInTheDocument();
  });
});
