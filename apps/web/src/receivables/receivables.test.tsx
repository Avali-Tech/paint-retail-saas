import {
  emptyTotals,
  type AgeingPage,
  type AgeingRowView,
  type AgeingTotals,
  type ReceivablesSummaryView,
} from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD, OWNER, json, profile } from '../test-support/fake-api.js';
import { HYD, STORES } from '../test-support/inventory-fixtures.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import { AGEING_PAGE_SIZE, groupOf } from './ReceivablesPage.js';

const location = () => screen.getByTestId('location').textContent;

const totals = (overrides: Partial<AgeingTotals['buckets']>, unapplied = 0): AgeingTotals => {
  const buckets = { ...emptyTotals().buckets, ...overrides };
  const outstanding = Object.values(buckets).reduce((sum, value) => sum + value, 0);
  return {
    buckets,
    outstandingPaise: outstanding,
    unappliedPaise: unapplied,
    netPaise: outstanding - unapplied,
  };
};

const row = (overrides: Partial<AgeingRowView>): AgeingRowView => ({
  id: 'party-1',
  name: 'Krishna Constructions',
  code: null,
  phone: '+919876543210',
  limitPaise: 5_000_00,
  customers: 1,
  maxDaysPastDue: 95,
  totals: totals({ not_due: 1_180_00, days_90_plus: 236_00 }),
  ...overrides,
});

const CUSTOMERS: AgeingPage = {
  asOf: '2026-10-11',
  groupBy: 'customer',
  rows: [
    row({}),
    row({
      id: 'party-2',
      name: 'Suresh Homes',
      phone: null,
      limitPaise: null,
      maxDaysPastDue: null,
      totals: totals({}, 300_00),
    }),
  ],
  totals: totals({ not_due: 1_180_00, days_90_plus: 236_00 }, 300_00),
  total: 2,
};

const SALESPEOPLE: AgeingPage = {
  ...CUSTOMERS,
  groupBy: 'salesperson',
  rows: [
    row({ id: 'member-9', name: 'Ravi', phone: null, limitPaise: null, customers: 1 }),
    row({ id: null, name: null, phone: null, limitPaise: null, customers: 2 }),
  ],
};

const STORE_ROWS: AgeingPage = {
  ...CUSTOMERS,
  groupBy: 'store',
  rows: [
    row({ id: HYD.id, name: HYD.name, code: HYD.code, phone: null, limitPaise: null }),
    row({ id: null, name: null, phone: null, limitPaise: null, maxDaysPastDue: 70 }),
  ],
};

const SUMMARY: ReceivablesSummaryView = {
  asOf: '2026-10-11',
  totals: CUSTOMERS.totals,
  dueTodayPaise: 118_00,
  dueThisWeekPaise: 236_00,
  overduePaise: 2_076_00,
  customers: 2,
  credit: { limitPaise: 5_000_00, usedPaise: 3_000_00, utilisationBps: 6_000, overLimit: 1 },
  topCustomers: [
    {
      partyId: 'party-1',
      name: 'Krishna Constructions',
      phone: null,
      netPaise: 1_416_00,
      overduePaise: 236_00,
      maxDaysPastDue: 95,
    },
    {
      partyId: 'party-3',
      name: 'Ramesh Painter',
      phone: null,
      netPaise: 1_500_00,
      overduePaise: 0,
      maxDaysPastDue: 0,
    },
  ],
};

function receivables(overrides: { summary?: unknown; ageing?: unknown } = {}) {
  const pick = (value: unknown, query: URLSearchParams) =>
    json(typeof value === 'function' ? (value as (q: URLSearchParams) => unknown)(query) : value);
  return {
    'GET /auth/me': () => json(OWNER),
    'GET /stores': () => json(STORES),
    'GET /receivables/summary': (request: { query: URLSearchParams }) =>
      pick(overrides.summary ?? SUMMARY, request.query),
    'GET /receivables/ageing': (request: { query: URLSearchParams }) =>
      pick(
        overrides.ageing ??
          ((query: URLSearchParams) =>
            query.get('groupBy') === 'salesperson'
              ? SALESPEOPLE
              : query.get('groupBy') === 'store'
                ? STORE_ROWS
                : CUSTOMERS),
        request.query,
      ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('groupOf', () => {
  it('reads the grouping from the address, customers by default', () => {
    expect(groupOf('store')).toBe('store');
    expect(groupOf('salesperson')).toBe('salesperson');
    expect(groupOf('')).toBe('customer');
    expect(groupOf('brand')).toBe('customer');
  });
});

describe('ReceivablesPage', { timeout: 30_000 }, () => {
  it('shows the figures, who owes most and the ageing by customer with the way to each ledger', async () => {
    const { requests } = renderApp({ path: '/receivables', routes: receivables() });
    expect(await screen.findByRole('heading', { name: 'Receivables', level: 1 })).toBeVisible();
    const tiles = await screen.findByRole('region', { name: 'Receivables figures' });
    expect(tiles).toHaveTextContent(
      'Total outstanding₹1,416.002 customers owe₹300.00 paid in advance',
    );
    expect(tiles).toHaveTextContent('Overdue₹2,076.00Due today ₹118.00Due this week ₹236.00');
    expect(tiles).toHaveTextContent('Credit used60%of ₹5,000.00 given1 customer over the limit');
    const top = screen.getByRole('region', { name: 'Who owes most' });
    expect(within(top).getByRole('link', { name: 'Krishna Constructions' })).toHaveAttribute(
      'href',
      '/parties/party-1/ledger',
    );
    expect(top).toHaveTextContent('₹1,416.00 · ₹236.00 overdue · 95 days late');
    expect(top).toHaveTextContent('Ramesh Painter₹1,500.00');
    expect(top).not.toHaveTextContent('0 days late');

    const table = await screen.findByRole('table', { name: 'Ageing by Customer' });
    const [head, krishna, suresh, foot] = within(table).getAllByRole('row');
    expect(head).toHaveTextContent(
      'NameNot yet due0–30 days31–60 days61–90 daysOver 90 daysTotalAdvanceBalanceMost days lateCredit limitOpen',
    );
    expect(krishna).toHaveTextContent(
      'Krishna Constructions+919876543210₹1,180.00₹0.00₹0.00₹0.00₹236.00₹1,416.00₹0.00₹1,416.0095₹5,000.00LedgerStatement',
    );
    expect(suresh).toHaveTextContent('Suresh Homes₹0.00₹0.00₹0.00₹0.00₹0.00₹0.00₹300.00-₹300.00');
    expect(foot).toHaveTextContent('All rows₹1,180.00');
    expect(within(table).getAllByRole('link', { name: 'Statement' })[0]).toHaveAttribute(
      'href',
      '/parties/party-1/statement',
    );
    expect(
      within(found(krishna)).getByRole('link', { name: 'Krishna Constructions' }),
    ).toHaveAttribute('href', '/parties/party-1/ledger');
    const ageing = requests.find((request) => request.path === '/receivables/ageing');
    expect(ageing?.query.toString()).toBe(
      `groupBy=customer&limit=${String(AGEING_PAGE_SIZE)}&offset=0`,
    );
  });

  it('narrows by day, store, search and lateness, keeping the filters in the address', async () => {
    const { user, requests } = renderApp({ path: '/receivables', routes: receivables() });
    await screen.findByRole('table', { name: 'Ageing by Customer' });
    await user.type(screen.getByLabelText('As of'), '2026-09-30');
    await user.selectOptions(screen.getByLabelText('Store'), HYD.id);
    await user.type(screen.getByLabelText('Customer or mobile'), 'krish');
    await user.click(screen.getByLabelText('Only rows with something overdue'));
    await waitFor(() => {
      expect(requests.at(-1)?.query.toString()).toBe(
        `asOf=2026-09-30&storeId=${HYD.id}&groupBy=customer&q=krish&overdueOnly=true&limit=50&offset=0`,
      );
    });
    const summary = requests.filter((request) => request.path === '/receivables/summary').at(-1);
    expect(summary?.query.toString()).toBe(`asOf=2026-09-30&storeId=${HYD.id}`);
    expect(location()).toContain('overdueOnly=true');
    await user.click(screen.getByLabelText('Only rows with something overdue'));
    await waitFor(() => {
      expect(location()).not.toContain('overdueOnly');
    });
  });

  it('groups by salesperson and opens one salesperson’s customers, and those of nobody', async () => {
    const { user, requests } = renderApp({ path: '/receivables', routes: receivables() });
    await screen.findByRole('table', { name: 'Ageing by Customer' });
    await user.selectOptions(screen.getByLabelText('Group by'), 'salesperson');
    const table = await screen.findByRole('table', { name: 'Ageing by Salesperson' });
    expect(within(table).getAllByRole('columnheader')[1]).toHaveTextContent('Customers');
    expect(within(table).queryByRole('link', { name: 'Statement' })).toBeNull();
    await user.click(within(table).getByRole('button', { name: 'Show the customers of Ravi' }));
    expect(await screen.findByText('Salesperson: Ravi')).toBeVisible();
    await waitFor(() => {
      expect(requests.at(-1)?.query.toString()).toBe(
        'salespersonId=member-9&groupBy=customer&limit=50&offset=0',
      );
    });
    await user.click(screen.getByRole('button', { name: 'Show everyone' }));
    await waitFor(() => {
      expect(screen.queryByText('Salesperson: Ravi')).toBeNull();
    });
    await user.selectOptions(screen.getByLabelText('Group by'), 'salesperson');
    await user.click(
      await screen.findByRole('button', { name: 'Show the customers of Not assigned' }),
    );
    expect(await screen.findByText('Salesperson: Not assigned')).toBeVisible();
    expect(location()).toContain('salespersonId=none');
    await user.selectOptions(screen.getByLabelText('Group by'), 'customer');
    await waitFor(() => {
      expect(location()).not.toContain('groupBy');
    });
  });

  it('names a salesperson filter from a shared link, and groups by store', async () => {
    const { user } = renderApp({
      path: '/receivables?salespersonId=member-9&groupBy=store',
      routes: receivables(),
    });
    expect(await screen.findByText('Salesperson: Salesperson')).toBeVisible();
    const table = await screen.findByRole('table', { name: 'Ageing by Store' });
    expect(table).toHaveTextContent('No store (opening balances)');
    expect(within(table).queryByRole('button', { name: /No store/ })).toBeNull();
    await user.click(
      within(table).getByRole('button', { name: 'Show the customers of Hyderabad' }),
    );
    await waitFor(() => {
      expect(location()).toBe(`/receivables?salespersonId=member-9&storeId=${HYD.id}`);
    });
  });

  it('pages through the ageing', async () => {
    const many = { ...CUSTOMERS, total: AGEING_PAGE_SIZE + 2 };
    const { user, requests } = renderApp({
      path: '/receivables',
      routes: receivables({ ageing: many }),
    });
    await screen.findByRole('table', { name: 'Ageing by Customer' });
    expect(screen.getByText('1–50 of 52')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(requests.at(-1)?.query.toString()).toBe('groupBy=customer&limit=50&offset=50');
    });
  });

  it('downloads the ageing as CSV, and says when it cannot', async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:csv'), revokeObjectURL: vi.fn() });
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record(
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    let answer = 0;
    const { user, requests } = renderApp({
      path: '/receivables?groupBy=store&asOf=2026-10-01',
      routes: {
        ...receivables(),
        'GET /reports/receivables-ageing': () => {
          answer += 1;
          if (answer === 1) {
            return {
              status: 200,
              raw: 'Name\r\n',
              headers: { 'content-disposition': 'attachment; filename="receivables-ageing-x.csv"' },
            };
          }
          if (answer === 2) return { status: 200, raw: 'Name\r\n' };
          return json({ statusCode: 403, message: 'No permission' }, 403);
        },
      },
    });
    const button = await screen.findByRole('button', { name: 'Download CSV' });
    await user.click(button);
    await waitFor(() => {
      expect(names).toEqual(['receivables-ageing-x.csv']);
    });
    const csv = requests.find((request) => request.path === '/reports/receivables-ageing');
    expect(csv?.query.toString()).toBe('groupBy=store&asOf=2026-10-01&format=csv');
    await user.click(button);
    await waitFor(() => {
      expect(names).toEqual(['receivables-ageing-x.csv', 'receivables-ageing.csv']);
    });
    await user.click(button);
    expect(await screen.findByText('Could not download the ageing')).toBeVisible();
  });

  it('says when nobody owes anything, and when there are no credit limits', async () => {
    renderApp({
      path: '/receivables',
      routes: receivables({
        ageing: { ...CUSTOMERS, rows: [], totals: emptyTotals(), total: 0 },
        summary: {
          ...SUMMARY,
          totals: emptyTotals(),
          topCustomers: [],
          credit: { limitPaise: 0, usedPaise: 0, utilisationBps: null, overLimit: 0 },
        },
      }),
    });
    expect(await screen.findByText('Nobody owes anything on this day')).toBeVisible();
    expect(screen.getByText('Nobody owes anything on this day.')).toBeVisible();
    const tiles = screen.getByRole('region', { name: 'Receivables figures' });
    expect(tiles).toHaveTextContent('Credit used—No credit limits set');
    expect(tiles).not.toHaveTextContent('paid in advance');
    expect(tiles).not.toHaveTextContent('over the limit');
  });

  it('is behind credit:read, as the receivables API is', async () => {
    renderApp({
      path: '/receivables',
      routes: { 'GET /auth/me': () => json(profile(['sales:read', 'parties:read'])) },
    });
    expect(await screen.findByText('No access')).toBeVisible();
  });
});

describe('the dashboard’s receivables tile', { timeout: 30_000 }, () => {
  const dashboardRoutes = {
    'GET /auth/me': () => json(OWNER),
    'GET /dashboard': () => json(DASHBOARD),
  };

  it('shows what is owed, overdue and due this week at the store on screen', async () => {
    const { requests } = renderApp({
      path: `/dashboard?store=${HYD.id}`,
      routes: { ...dashboardRoutes, 'GET /receivables/summary': () => json(SUMMARY) },
    });
    const tile = (await screen.findByRole('heading', { name: 'Receivables' })).closest('section');
    await waitFor(() => {
      expect(tile).toHaveTextContent('Overdue ₹2,076.00Due this week ₹236.00');
    });
    expect(within(found(tile)).getByRole('link', { name: 'Open receivables' })).toHaveAttribute(
      'href',
      `/receivables?storeId=${HYD.id}`,
    );
    expect(requests.find((r) => r.path === '/receivables/summary')?.query.toString()).toBe(
      `storeId=${HYD.id}`,
    );
  });

  it('shows nothing overdue plainly, and says when it cannot load', async () => {
    renderApp({
      path: '/dashboard',
      routes: {
        ...dashboardRoutes,
        'GET /receivables/summary': () => json({ ...SUMMARY, overduePaise: 0 }),
      },
    });
    const tile = (await screen.findByRole('heading', { name: 'Receivables' })).closest('section');
    await waitFor(() => {
      expect(tile).toHaveTextContent('Overdue ₹0.00');
    });
    expect(within(found(tile)).getByRole('link', { name: 'Open receivables' })).toHaveAttribute(
      'href',
      '/receivables',
    );
  });

  it('says when the figures cannot load, and is not shown without credit:read', async () => {
    renderApp({
      path: '/dashboard',
      routes: {
        ...dashboardRoutes,
        'GET /receivables/summary': () => json({ statusCode: 500, message: 'Oops' }, 500),
      },
    });
    expect(await screen.findByText('Could not load receivables')).toBeVisible();
  });

  it('is left out for members who do not see credit', async () => {
    const { requests } = renderApp({
      path: '/dashboard',
      routes: {
        'GET /auth/me': () => json(profile(['stores:read', 'inventory:read'])),
        'GET /dashboard': () => json(DASHBOARD),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await screen.findAllByRole('region');
    expect(screen.queryByRole('heading', { name: 'Receivables' })).toBeNull();
    expect(requests.some((r) => r.path === '/receivables/summary')).toBe(false);
  });
});
