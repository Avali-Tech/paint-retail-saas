import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Dashboard } from '../api/types.js';
import { createI18n, stageLabel } from '../i18n/i18n.js';
import { CASHIER, DASHBOARD, OWNER, json } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { found } from '../test-support/found.js';

function renderDashboard(
  answer: (storeId: string | null) => ReturnType<typeof json> | Promise<never>,
  member = OWNER,
) {
  return renderApp({
    path: '/dashboard',
    routes: {
      'GET /auth/me': () => json(member),
      'GET /dashboard': (request) => answer(request.query.get('storeId')),
    },
  });
}

describe('stageLabel', () => {
  it('names known stages and shows unknown ones as they are', () => {
    const { t } = createI18n('en');
    expect(stageLabel(t, 'qualified')).toBe('Qualified');
    expect(stageLabel(t, 'on_hold')).toBe('On hold');
  });
});

describe('DashboardPage', () => {
  it('shows totals, every store and the pipelines', async () => {
    renderDashboard(() => json(DASHBOARD));
    const totals = await screen.findByRole('region', { name: 'Total' });
    const stockTile = found(
      within(totals).getByRole('heading', { name: 'Stock value' }).closest('section'),
    );
    expect(stockTile).toHaveTextContent('₹18.94 L');
    expect(stockTile).toHaveTextContent('4 SKUs');
    expect(stockTile).toHaveTextContent('1 without a cost');
    expect(within(totals).getByText('₹18.94 L')).toHaveAttribute('title', '₹18,94,000.00');
    expect(totals).toHaveTextContent('Low stock6');
    // A manager's tile counts the team's follow-ups and opens them.
    expect(totals).toHaveTextContent('Team follow-ups3');
    expect(
      within(totals).getByRole('link', { name: 'Open the team’s follow-ups' }),
    ).toHaveAttribute('href', '/follow-ups?assignedTo=everyone');

    const stores = screen.getByRole('table', { name: 'Stores' });
    const rows = within(stores).getAllByRole('row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'StoreStock valueUnitsSKUsOut of stockBelow minimumIncomingPurchase ordersStill due',
      'HYD Hyderabad₹24,000.001321112₹6,000.00',
      'PUN Pune₹18,70,000.001321110₹0.00',
      'Total₹18,94,000.002642222₹6,000.00',
    ]);

    const leads = screen.getByRole('table', { name: 'Leads' });
    expect(within(leads).getAllByRole('row')[1]).toHaveTextContent('New1₹1,000.00');
    const opportunities = screen.getByRole('table', { name: 'Opportunities' });
    expect(within(opportunities).getAllByRole('row')[1]).toHaveTextContent(
      'Discovery1₹5,000.00₹1,000.00',
    );
    expect(
      within(screen.getByRole('region', { name: 'Projects' })).getByText('Nothing here yet'),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
  });

  it('filters to one store and back', async () => {
    const pune = { ...DASHBOARD, stores: DASHBOARD.stores.slice(1) };
    const { user, requests } = renderDashboard((storeId) => json(storeId ? pune : DASHBOARD));
    const picker = await screen.findByRole('combobox', { name: 'Store' });
    await user.selectOptions(picker, 'PUN · Pune');
    await waitFor(() => {
      expect(
        within(screen.getByRole('table', { name: 'Stores' })).getAllByRole('row'),
      ).toHaveLength(2);
    });
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard?store=store-pun');
    // The team's follow-ups at the same store.
    expect(screen.getByRole('link', { name: 'Open the team’s follow-ups' })).toHaveAttribute(
      'href',
      '/follow-ups?assignedTo=everyone&storeId=store-pun',
    );
    expect(requests.some((request) => request.query.get('storeId') === 'store-pun')).toBe(true);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'All stores');
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/dashboard$/);
  });

  it('refreshes on request', async () => {
    let calls = 0;
    const { user } = renderDashboard(() => {
      calls += 1;
      return json(DASHBOARD);
    });
    await screen.findByRole('table', { name: 'Stores' });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(calls).toBe(2);
    });
  });

  it('shows skeletons while loading', async () => {
    const { container } = renderDashboard(() => new Promise<never>(() => undefined));
    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
    expect(container.querySelectorAll('.ui-skeleton').length).toBeGreaterThan(0);
    expect(screen.getByText('Every store at a glance')).toBeInTheDocument();
  });

  it('explains a failure and retries', async () => {
    let fail = true;
    const { user } = renderDashboard(() =>
      fail ? json({ message: 'Database down' }, 503) : json(DASHBOARD),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the dashboardDatabase down');
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Stores' })).toBeInTheDocument();
  });

  it('welcomes a business without stores', async () => {
    renderDashboard(() => json({ ...DASHBOARD, stores: [] }));
    expect(await screen.findByText('No stores yet')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Store' })).toBeNull();
  });

  it('shows stock on hand, not its value, without costs:read', async () => {
    const noCosts: Dashboard = {
      ...DASHBOARD,
      stores: DASHBOARD.stores.map((row) => ({
        ...row,
        stock: row.stock && { ...row.stock, valuePaise: null },
      })),
      totals: {
        ...DASHBOARD.totals,
        stock: DASHBOARD.totals.stock && { ...DASHBOARD.totals.stock, valuePaise: null },
      },
    };
    renderDashboard(() => json(noCosts));
    const totals = await screen.findByRole('region', { name: 'Total' });
    expect(within(totals).getByRole('heading', { name: 'Stock on hand' })).toBeVisible();
    expect(within(totals).queryByRole('heading', { name: 'Stock value' })).toBeNull();
    const table = screen.getByRole('table', { name: 'Stores' });
    expect(within(table).queryByRole('columnheader', { name: 'Stock value' })).toBeNull();
    expect(within(table).getByRole('columnheader', { name: 'Units' })).toBeVisible();
  });

  it('leaves out what the member’s role cannot see', async () => {
    const limited: Dashboard = {
      ...DASHBOARD,
      stores: DASHBOARD.stores.slice(0, 1).map((row) => ({
        ...row,
        stock: null,
        lowStock: null,
        transfers: null,
        purchaseOrders: null,
      })),
      totals: { stock: null, lowStock: null, transfers: null, purchaseOrders: null },
      leads: null,
      opportunities: null,
      projects: null,
      followUps: { scope: 'mine', overdue: 0, today: 0 },
    };
    renderDashboard(() => json(limited), CASHIER);
    const table = await screen.findByRole('table', { name: 'Stores' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual(['Store', 'HYD Hyderabad']);
    const totals = screen.getByRole('region', { name: 'Total' });
    expect(
      within(totals)
        .getAllByRole('heading')
        .map((heading) => heading.textContent),
    ).toEqual(['My follow-ups']);
    expect(within(totals).getByRole('link', { name: 'Open my follow-ups' })).toHaveAttribute(
      'href',
      '/follow-ups',
    );
    expect(screen.queryByRole('table', { name: 'Leads' })).toBeNull();
  });
});
