import { planStockUp, type PriceHikePlanView, type SchemesOverview } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DASHBOARD, OWNER, json, profile } from '../test-support/fake-api.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';

// The price-hike planner screen and the dashboard's brand schemes tile (P2-M33).

const BRANDS = [{ id: 'brand-apex', name: 'Apex Paints', isActive: true }];
const STORES = [{ id: 'store-hyd', name: 'Hyderabad', code: 'HYD' }];

const skus = [
  {
    variantId: 'v-ult-20',
    sku: 'ULT-20L',
    productName: 'Apex Paints Ultima',
    unitCostPaise: 4_000_00,
    stockUnits: 10,
    soldUnits: 90,
  },
];

const planFor = (effectiveOn: string, asOf: string, withoutCost = 0): PriceHikePlanView => ({
  asOf,
  brand: { id: 'brand-apex', name: 'Apex Paints' },
  plan: planStockUp(
    { hikeBasisPoints: 500, effectiveOn },
    skus.map((sku) => ({ ...sku, salesWindowDays: 90, deadStockRiskBps: null })),
    asOf,
  ),
  skus,
  withoutCost,
});

describe('PriceHikePage', { timeout: 30_000 }, () => {
  it('plans a stock-up from the fields, checking them first, and shows the plan', async () => {
    const asked: unknown[] = [];
    let answers = 0;
    const { user } = renderApp({
      path: '/brand-schemes/price-hike',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /brands': () => json(BRANDS),
        'GET /stores': () => json(STORES),
        'POST /brand-schemes/price-hike-plan': (request) => {
          asked.push(request.body);
          answers += 1;
          if (answers === 1) return json(planFor('2026-10-26', '2026-10-16', 2));
          if (answers === 2) return json(planFor('2026-10-10', '2026-10-16'));
          return json({ statusCode: 404, message: 'Brand not found' }, 404);
        },
      },
    });
    await screen.findByRole('heading', { name: 'Price-hike planner' });
    const plan = screen.getByRole('button', { name: 'Plan' });
    await user.click(plan);
    expect(screen.getByText('Choose the brand')).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Apex Paints' })).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Brand' }), 'brand-apex');
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Hyderabad' })).toBeInTheDocument();
    });
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Stock and sales at' }),
      'store-hyd',
    );
    await user.type(screen.getByRole('textbox', { name: 'Price rise (%)' }), '5');
    const effective = screen.getByLabelText('New price from');
    await user.clear(effective);
    await user.type(effective, '2026-10-26');
    await user.click(plan);
    const result = await screen.findByRole('table', { name: 'Stock-up plan' });
    expect(screen.getByRole('heading', { name: 'Plan for Apex Paints' })).toBeVisible();
    expect(screen.getByText('2 packs have no cost yet and are left out.')).toBeVisible();
    const line = within(result).getAllByRole('row')[1];
    expect(line).toHaveTextContent('Apex Paints Ultima ULT-20L1090₹4,000.00');
    expect(asked[0]).toEqual({
      brandId: 'brand-apex',
      hikeBasisPoints: 500,
      effectiveOn: '2026-10-26',
      productIds: [],
      categoryIds: [],
      storeId: 'store-hyd',
      salesWindowDays: 90,
      holdingCostBps: 600,
      costOfMoneyBps: 1200,
      deadStockRiskBps: 400,
      maxCoverDays: 90,
    });

    await user.click(plan);
    expect(
      await screen.findByText('The new price is already in force: nothing to buy ahead.'),
    ).toBeVisible();
    await user.click(plan);
    expect(await screen.findByText('Brand not found')).toBeVisible();
  });
});

const overview = (changes: Partial<SchemesOverview>): SchemesOverview => ({
  asOf: '2026-08-15',
  activeSchemes: 2,
  nearest: {
    schemeId: 'scheme-berger',
    schemeName: 'Berger quarter',
    brandName: 'Berger',
    measure: 'value',
    distance: 5_000_00,
    perDayNeeded: 10_870,
    remainingDays: 46,
  },
  outstandingPaise: 1_700_00,
  openClaims: 1,
  overdueClaims: 1,
  ...changes,
});

function renderDashboard(answer: () => ReturnType<typeof json>, member = OWNER) {
  return renderApp({
    path: '/dashboard',
    routes: {
      'GET /auth/me': () => json(member),
      'GET /dashboard': () => json(DASHBOARD),
      'GET /brand-schemes/overview': answer,
    },
  });
}

describe('the brand schemes tile', { timeout: 30_000 }, () => {
  it('shows what brands owe, overdue claims and the nearest slab', async () => {
    renderDashboard(() => json(overview({})));
    const tile = found(
      (await screen.findByRole('heading', { name: 'Brand schemes' })).closest<HTMLElement>('.tile'),
    );
    expect(tile).toHaveTextContent('₹1,700still owed by brands1 overdue');
    expect(tile).toHaveTextContent(
      'Nearest slab: Berger · Berger quarter, ₹5,000.00 more in 46 days',
    );
    expect(within(tile).getByRole('link', { name: 'Open brand schemes' })).toHaveAttribute(
      'href',
      '/brand-schemes',
    );
  });

  it('leaves out what is not there, and the tile once nothing runs or is owed', async () => {
    const { unmount } = renderDashboard(() =>
      json(overview({ nearest: null, overdueClaims: 0, outstandingPaise: 0 })),
    );
    const tile = found(
      (await screen.findByRole('heading', { name: 'Brand schemes' })).closest<HTMLElement>('.tile'),
    );
    expect(tile).not.toHaveTextContent('overdue');
    expect(tile).not.toHaveTextContent('Nearest slab');
    unmount();
    const { requests } = renderDashboard(() =>
      json(overview({ activeSchemes: 0, nearest: null, outstandingPaise: 0 })),
    );
    await screen.findByRole('region', { name: 'Total' });
    await waitFor(() => {
      expect(requests.some((request) => request.path === '/brand-schemes/overview')).toBe(true);
    });
    expect(screen.queryByRole('heading', { name: 'Brand schemes' })).toBeNull();
  });

  it('is not shown to members who do not see purchasing', async () => {
    const { requests } = renderDashboard(
      () => json(overview({})),
      profile(['stores:read', 'inventory:read']),
    );
    await screen.findByRole('region', { name: 'Total' });
    expect(requests.some((request) => request.path === '/brand-schemes/overview')).toBe(false);
  });
});
