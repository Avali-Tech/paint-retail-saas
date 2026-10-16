import { salesOverview, type DaySales, type SalesOverview } from '@paint/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CASHIER, DASHBOARD, OWNER, json } from '../test-support/fake-api.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';

// Saturday 17 October 2026: today ₹2,230 against ₹2,050 yesterday, this week up from the
// last, and nothing in last month to compare the month with.
const DAYS: DaySales[] = [
  {
    day: '2026-10-17',
    billsTaxablePaise: 243_000,
    taxablePaise: 223_000,
    taxPaise: 27_400,
    bills: 2,
    creditNotes: 2,
  },
  {
    day: '2026-10-16',
    billsTaxablePaise: 200_000,
    taxablePaise: 205_000,
    taxPaise: 36_900,
    bills: 1,
    creditNotes: 0,
  },
  {
    day: '2026-10-09',
    billsTaxablePaise: 900_000,
    taxablePaise: 900_000,
    taxPaise: 0,
    bills: 1,
    creditNotes: 0,
  },
];
const OVERVIEW = salesOverview('2026-10-17', DAYS, '2026-10-17T06:00:00.000Z');

function renderTile(
  answer: (storeId: string | null) => ReturnType<typeof json>,
  member = OWNER,
  path = '/dashboard',
) {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(member),
      'GET /dashboard': () => json(DASHBOARD),
      'GET /dashboard/sales': (request) => answer(request.query.get('storeId')),
    },
  });
}

/** The tile, once its figures are in. */
const tile = async () => {
  await screen.findByRole('heading', { name: 'Today' });
  return found(screen.getByRole('heading', { name: 'Net sales (before GST)' }).closest('section'));
};

describe('the sales tile', () => {
  it('shows today, the week and the month against before, and links into the sales report', async () => {
    renderTile(() => json(OVERVIEW));
    const sales = await tile();
    const today = found(within(sales).getByRole('heading', { name: 'Today' }).parentElement);
    expect(within(today).getByRole('link', { name: '₹2,230.00' })).toHaveAttribute(
      'href',
      '/reports/sales-by-period?from=2026-10-17&to=2026-10-17',
    );
    expect(today).toHaveTextContent('₹2,504.00 with GST');
    expect(today).toHaveTextContent('Up 8.78% on yesterday');
    expect(today).toHaveTextContent('2 bills · average ₹1,215.00');
    const week = found(within(sales).getByRole('heading', { name: 'This week' }).parentElement);
    expect(week).toHaveTextContent('Down 52.44% on last week');
    const month = found(within(sales).getByRole('heading', { name: 'This month' }).parentElement);
    expect(month).toHaveTextContent('No sales last month to compare');
    // The trend reads as a table to a screen reader.
    const trend = within(sales).getByRole('table', { name: 'Last 14 days' });
    expect(within(trend).getAllByRole('row')).toHaveLength(15);
    expect(within(sales).getByRole('link', { name: 'Open the sales reports' })).toHaveAttribute(
      'href',
      '/reports#sales',
    );
  });

  it('keeps to the store the dashboard shows, and draws an empty fortnight flat', async () => {
    const empty: SalesOverview = salesOverview('2026-10-17', [], '2026-10-17T06:00:00.000Z');
    const { requests } = renderTile(() => json(empty), OWNER, '/dashboard?store=store-hyd');
    const sales = await tile();
    expect(within(sales).getAllByRole('link', { name: '₹0.00' })[0]).toHaveAttribute(
      'href',
      '/reports/sales-by-period?from=2026-10-17&to=2026-10-17&storeId=store-hyd',
    );
    expect(sales).not.toHaveTextContent('average');
    expect(
      requests.some((r) => r.path === '/dashboard/sales' && r.query.get('storeId') === 'store-hyd'),
    ).toBe(true);
    const bars = sales.querySelectorAll<HTMLElement>('.sales-tile__bar');
    expect([...bars].every((bar) => bar.style.blockSize === '0%')).toBe(true);
  });

  it('says when sales cannot be loaded', async () => {
    renderTile(() => json({ message: 'Database down' }, 503));
    expect(await screen.findByText('Could not load sales')).toBeVisible();
  });

  it('is only for members who read sales', async () => {
    renderTile(() => json(OVERVIEW), CASHIER);
    expect(await screen.findByRole('heading', { name: 'Stock value' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Net sales (before GST)' })).toBeNull();
  });
});
