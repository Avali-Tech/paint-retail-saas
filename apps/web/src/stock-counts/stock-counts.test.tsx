import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CountListItem, StoreAccuracy } from '../api/stock-counts.js';
import { CASHIER, OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { BRANDS, CATEGORIES, HYD, PUN, STORES, page } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { stockCount } from '../transfers/test-support/fixtures.js';

const item: CountListItem = {
  id: 'count-1',
  number: 'SC-000001',
  status: 'submitted',
  store: { id: HYD.id, code: HYD.code },
  scope: 'brand',
  startedAt: '2026-10-01T05:00:00.000Z',
};

const ACCURACY: StoreAccuracy[] = [
  {
    store: { id: HYD.id, code: HYD.code, name: HYD.name },
    lastCount: {
      number: 'SC-000002',
      approvedAt: '2026-09-20T05:00:00.000Z',
      accuracyPercent: 96.5,
      countedLines: 40,
    },
  },
  {
    store: { id: PUN.id, code: PUN.code, name: PUN.name },
    lastCount: {
      number: 'SC-000003',
      approvedAt: '2026-09-21T05:00:00.000Z',
      accuracyPercent: null,
      countedLines: 0,
    },
  },
  { store: { id: 'store-sec', code: 'SEC', name: 'Secunderabad' }, lastCount: null },
];

const location = () => screen.getByTestId('location').textContent;

function renderCounts(
  routes: Record<string, FakeHandler> = {},
  member = OWNER,
  path = '/stock-counts',
) {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(member),
      'GET /stores': () => json(STORES),
      'GET /stock-counts': () => json(page([item])),
      'GET /stock-counts/accuracy': () => json(ACCURACY),
      'GET /brands': () => json(BRANDS),
      'GET /categories': () => json(CATEGORIES),
      'GET /stock-counts/:id': () => json(stockCount()),
      ...routes,
    },
  });
}

const rows = (name: string) =>
  within(screen.getByRole('table', { name }))
    .getAllByRole('row')
    .map((row) => row.textContent);

describe('StockCountsPage', () => {
  it('lists counts and each store’s accuracy', async () => {
    renderCounts();
    await screen.findByRole('table', { name: 'Stock counts' });
    expect(rows('Stock counts')).toEqual([
      'NumberStoreWhat is countedStatusStarted',
      'SC-000001HYDOne brandSubmitted1 Oct 2026',
    ]);
    expect(await screen.findByRole('table', { name: 'Accuracy by store' })).toBeInTheDocument();
    expect(rows('Accuracy by store')).toEqual([
      'StoreLast approved countAccuracy',
      'HYD · HyderabadSC-000002 · 20 Sept 202640 products counted96.5%',
      'PUN · PuneSC-000003 · 21 Sept 20260 products counted—',
      'SEC · SecunderabadNever counted',
    ]);
    expect(screen.getByRole('link', { name: '+ Stock count' })).toHaveAttribute(
      'href',
      '/stock-counts/new',
    );
  });

  it('filters by store and status, with an empty list and no stores', async () => {
    const { user, requests } = renderCounts(
      {
        'GET /stock-counts': (request) =>
          json(request.query.has('status') ? page([]) : page([item], 75)),
        'GET /stock-counts/accuracy': () => json([]),
      },
      CASHIER,
    );
    expect(await screen.findByText('No stores yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '+ Stock count' })).toBeNull();
    await screen.findByRole('navigation', { name: 'Stock count pages' });
    await screen.findAllByRole('option', { name: 'PUN · Pune' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'PUN · Pune');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Approved');
    expect(await screen.findByText('No counts match these filters')).toBeInTheDocument();
    expect(location()).toBe('/stock-counts?store=store-pun&status=approved');
    expect(
      requests
        .filter((request) => request.path === '/stock-counts')
        .at(-1)
        ?.query.toString(),
    ).toBe('storeId=store-pun&status=approved&limit=50&offset=0');
  });

  it('invites a first count', async () => {
    renderCounts({ 'GET /stock-counts': () => json(page([])) });
    expect(await screen.findByText('No stock counts yet')).toBeInTheDocument();
  });
});

describe('NewStockCountPage', () => {
  it('starts a count of one brand and opens it', async () => {
    const { user, requests } = renderCounts(
      {
        'POST /stock-counts': () =>
          json(stockCount({ scope: 'brand', scopeId: 'brand-asian' }), 201),
      },
      OWNER,
      '/stock-counts/new',
    );
    const submit = await screen.findByRole('button', { name: 'Start count' });
    await user.click(submit);
    expect(screen.getByText('This is required')).toBeInTheDocument();
    await screen.findAllByRole('option', { name: 'HYD · Hyderabad' });
    await user.selectOptions(screen.getByRole('combobox', { name: /Store/ }), 'HYD · Hyderabad');
    const scope = screen.getByRole('combobox', { name: 'What to count' });
    await user.selectOptions(scope, 'One category');
    expect(await screen.findByRole('option', { name: 'Interior emulsions' })).toBeInTheDocument();
    await user.selectOptions(scope, 'One brand');
    await user.click(submit);
    expect(screen.getByText('This is required')).toBeInTheDocument();
    const brand = screen.getByRole('combobox', { name: /Brand/ });
    await screen.findByRole('option', { name: 'Asian Paints' });
    expect(within(brand).queryByRole('option', { name: 'Old Brand' })).toBeNull();
    await user.selectOptions(brand, 'Asian Paints');
    await user.type(screen.getByRole('textbox', { name: 'Note' }), ' Monthly ');
    await user.click(submit);
    await waitFor(() => {
      expect(location()).toBe('/stock-counts/count-1');
    });
    expect(await screen.findByText('Count SC-000001 started')).toBeInTheDocument();
    expect(requests.find((request) => request.method === 'POST')?.body).toEqual({
      storeId: 'store-hyd',
      scope: 'brand',
      scopeId: 'brand-asian',
      note: 'Monthly',
    });
  });

  it('starts a whole-store count, or says why it cannot', async () => {
    let open = true;
    const { user, requests } = renderCounts(
      {
        'POST /stock-counts': () =>
          open
            ? json(
                {
                  statusCode: 409,
                  message: 'A count is already open at this store; finish or cancel it first',
                },
                409,
              )
            : json(stockCount(), 201),
      },
      OWNER,
      '/stock-counts/new',
    );
    await screen.findAllByRole('option', { name: 'HYD · Hyderabad' });
    await user.selectOptions(screen.getByRole('combobox', { name: /Store/ }), 'HYD · Hyderabad');
    await user.click(screen.getByRole('button', { name: 'Start count' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A count is already open');
    open = false;
    await user.click(screen.getByRole('button', { name: 'Start count' }));
    await waitFor(() => {
      expect(location()).toBe('/stock-counts/count-1');
    });
    expect(requests.filter((request) => request.method === 'POST').at(-1)?.body).toEqual({
      storeId: 'store-hyd',
      scope: 'full',
    });
  });
});
