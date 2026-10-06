import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import {
  ALL_REPORTS,
  LEADS_REPORT,
  STOCK_REPORT,
  leadsPage,
} from '../test-support/report-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { REPORT_PAGE_SIZE } from './ReportPage.js';

const NO_HEADERS: Record<string, string> = {};

const STORES = [
  {
    id: 'store-hyd',
    code: 'HYD',
    name: 'Hyderabad',
    type: 'store',
    city: null,
    state: null,
    gstin: null,
    isActive: true,
  },
];
const location = () => screen.getByTestId('location').textContent;
const click = vi.fn<(this: HTMLAnchorElement) => void>();

beforeEach(() => {
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:csv'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record(
    this: HTMLAnchorElement,
  ) {
    click.call(this);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  click.mockClear();
});

describe('ReportsPage', { timeout: 30_000 }, () => {
  it('lists the reports the role may run, in the member’s language', async () => {
    const { user } = renderApp({
      path: '/reports',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /reports': () => json(ALL_REPORTS),
        'GET /reports/:kind': () => json(leadsPage([])),
        'GET /stores': () => json(STORES),
      },
    });
    expect(await screen.findByRole('region', { name: 'Stock ledger' })).toHaveTextContent(
      'Every stock movement with who made it, newest first',
    );
    // A report this app does not know yet keeps the API's title.
    expect(screen.getByRole('region', { name: 'Sales by day' })).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'Open Leads' }));
    expect(await screen.findByRole('heading', { name: 'Leads', level: 1 })).toBeVisible();
    expect(location()).toBe('/reports/leads');
  });

  it('explains an empty list and a failure', async () => {
    const view = renderApp({
      path: '/reports',
      routes: { 'GET /auth/me': () => json(OWNER), 'GET /reports': () => json([]) },
    });
    expect(await screen.findByText('No reports are available with your role')).toBeVisible();
    view.unmount();
    renderApp({
      path: '/reports',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /reports': () => json({ message: 'Database down' }, 503),
      },
    });
    expect(await screen.findByText('Could not load the reports')).toBeVisible();
  });

  it('is closed to roles without any report', async () => {
    renderApp({
      path: '/reports',
      routes: { 'GET /auth/me': () => json(profile(['parties:read'])) },
    });
    expect(await screen.findByText('No access')).toBeVisible();
  });
});

describe('ReportPage', { timeout: 30_000 }, () => {
  it('filters, pages and shows a report, and downloads it as CSV', async () => {
    let csv: 'named' | 'unnamed' | 'down' = 'named';
    const { user, requests } = renderApp({
      path: '/reports/leads',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /reports': () => json([LEADS_REPORT]),
        'GET /stores': () => json(STORES),
        'GET /reports/leads': (request) => {
          if (request.query.get('format') === 'csv') {
            if (csv === 'down') return json({ message: 'Database down' }, 503);
            return {
              status: 200,
              raw: '\uFEFFLead,Stage',
              headers:
                csv === 'named'
                  ? { 'content-disposition': 'attachment; filename="leads-2026-10-06.csv"' }
                  : NO_HEADERS,
            };
          }
          return request.query.get('offset') === '0'
            ? json(
                leadsPage(
                  [
                    {
                      number: 'LD-000001',
                      stage: 'new',
                      estimatedValue: '250000.00',
                      products: 1200,
                    },
                    { number: 'LD-000002', stage: 'won', estimatedValue: null },
                  ],
                  REPORT_PAGE_SIZE + 1,
                ),
              )
            : json(leadsPage([]));
        },
      },
    });
    const table = await screen.findByRole('table', { name: 'Leads' });
    expect(
      screen.getByText('Leads with their source, stage, estimated value and owner'),
    ).toBeVisible();
    const [, first, second] = within(table).getAllByRole('row');
    expect(first).toHaveTextContent('LD-000001new250000.001,200');
    expect(second).toHaveTextContent('LD-000002won——');
    expect(requests.at(-1)?.query.toString()).toBe('limit=50&offset=0');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Stage' }), 'Qualified');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Source' }), 'Walk-in');
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Store' }),
      'HYD · Hyderabad',
    );
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-09-01' } });
    expect(await screen.findByText('The “to” date cannot be before the “from” date')).toBeVisible();
    await waitFor(() => {
      expect(requests.at(-1)?.query.toString()).toBe(
        'storeId=store-hyd&from=2026-10-01&stage=qualified&source=walk_in&limit=50&offset=0',
      );
    });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-10-31' } });
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('to')).toBe('2026-10-31');
    });
    expect(location()).toBe(
      '/reports/leads?stage=qualified&source=walk_in&storeId=store-hyd&from=2026-10-01&to=2026-10-31',
    );

    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => {
      expect(click).toHaveBeenCalledOnce();
    });
    expect(click.mock.contexts[0]?.download).toBe('leads-2026-10-06.csv');
    const download = requests.find((request) => request.query.get('format') === 'csv');
    expect(download?.query.toString()).toBe(
      'storeId=store-hyd&from=2026-10-01&to=2026-10-31&stage=qualified&source=walk_in&format=csv',
    );
    expect(download?.headers.authorization).toBe('Bearer session-token');

    csv = 'unnamed';
    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => {
      expect(click).toHaveBeenCalledTimes(2);
    });
    expect(click.mock.contexts[1]?.download).toBe('leads.csv');

    csv = 'down';
    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(await screen.findByText('Could not download the report')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Nothing matches these filters')).toBeVisible();
  });

  it('offers each report’s own filters', async () => {
    const { user, requests } = renderApp({
      path: '/reports/stock-by-location',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /reports': () => json(ALL_REPORTS),
        'GET /stores': () => json(STORES),
        'GET /suppliers': () => json({ items: [{ id: 'sup-1', name: 'Berger Depot' }], total: 1 }),
        'GET /reports/:kind': () => json({ ...leadsPage([]), columns: STOCK_REPORT.columns }),
      },
    });
    const inStock = await screen.findByRole('checkbox', { name: 'Only products in stock' });
    expect(inStock).toBeChecked();
    await user.click(inStock);
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('inStockOnly')).toBe('false');
    });
    await user.click(inStock);
    // Back to the API's default (and the list already loaded for it).
    await waitFor(() => {
      expect(location()).toBe('/reports/stock-by-location');
    });
    expect(inStock).toBeChecked();

    await user.click(screen.getByRole('link', { name: 'All reports' }));
    await user.click(await screen.findByRole('link', { name: 'Open Stock ledger' }));
    expect(await screen.findByRole('combobox', { name: 'Movement' })).toHaveTextContent(
      'Stock count correction',
    );
    await user.click(screen.getByRole('link', { name: 'All reports' }));
    await user.click(await screen.findByRole('link', { name: 'Open Goods receipts' }));
    const supplier = await screen.findByRole('combobox', { name: 'Supplier' });
    expect(await within(supplier).findByRole('option', { name: 'Berger Depot' })).toBeVisible();
    await user.selectOptions(supplier, 'Berger Depot');
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('supplierId')).toBe('sup-1');
    });
    await user.click(screen.getByRole('link', { name: 'All reports' }));
    await user.click(await screen.findByRole('link', { name: 'Open Sales by day' }));
    await user.type(await screen.findByRole('textbox', { name: 'Channel' }), 'online');
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('channel')).toBe('online');
    });
  });

  it('points out a date that is not one, without sending it', async () => {
    const { requests } = renderApp({
      path: '/reports/leads?from=2026-13-01',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /reports': () => json([LEADS_REPORT]),
        'GET /stores': () => json(STORES),
        'GET /reports/leads': () => json(leadsPage([])),
      },
    });
    expect(await screen.findByText('Enter a date')).toBeVisible();
    expect(await screen.findByText('Nothing matches these filters')).toBeVisible();
    expect(requests.at(-1)?.query.has('from')).toBe(false);
  });

  it('says when a report does not exist or cannot be loaded', async () => {
    const view = renderApp({
      path: '/reports/salaries',
      routes: { 'GET /auth/me': () => json(OWNER), 'GET /reports': () => json(ALL_REPORTS) },
    });
    expect(
      await screen.findByText('This report does not exist, or your role cannot see it.'),
    ).toBeVisible();
    view.unmount();
    renderApp({
      path: '/reports/projects',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /reports': () => json(ALL_REPORTS),
        'GET /reports/:kind': () => json({ message: 'Database down' }, 503),
      },
    });
    expect(await screen.findByText('Could not load this report')).toBeVisible();
  });
});
