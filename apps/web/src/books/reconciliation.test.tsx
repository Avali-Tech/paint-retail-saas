import type { ReconciliationFindingView, ReconciliationRunView } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { PREVIEW } from './test-support/books-fixtures.js';

const NONE = { stock_on_hand: 0, stock_reserved: 0, party_balance: 0, allocation: 0 };

const run = (overrides: Partial<ReconciliationRunView> = {}): ReconciliationRunView => ({
  id: 'run-1',
  trigger: 'manual',
  runOn: '2026-10-09',
  ranAt: '2026-10-09T05:30:00.000Z',
  requestedBy: { memberId: 'member-1', name: 'Anil Kumar' },
  findingCount: 0,
  counts: NONE,
  findings: [],
  ...overrides,
});

const finding = (overrides: Partial<ReconciliationFindingView>): ReconciliationFindingView => ({
  id: 'finding-1',
  kind: 'stock_on_hand',
  store: null,
  variant: null,
  party: null,
  recorded: 0,
  expected: 0,
  difference: 0,
  advancePaise: null,
  unallocatedPaise: null,
  ...overrides,
});

const NIGHTLY = run({
  trigger: 'scheduled',
  requestedBy: null,
  findingCount: 3,
  counts: { stock_on_hand: 1, stock_reserved: 0, party_balance: 1, allocation: 1 },
  findings: [
    finding({
      kind: 'stock_on_hand',
      store: { id: 'store-amp', name: 'Ameerpet' },
      variant: { id: 'variant-1', sku: 'APX-1L', name: 'Apex Ultima 1 l' },
      recorded: 12,
      expected: 10.5,
      difference: 1.5,
    }),
    finding({
      id: 'finding-2',
      kind: 'party_balance',
      party: { id: 'party-1', name: 'Deccan Contractors' },
      recorded: 24_100,
      expected: 23_600,
      difference: 500,
    }),
    finding({
      id: 'finding-3',
      kind: 'allocation',
      party: { id: 'party-1', name: 'Deccan Contractors' },
      recorded: 24_100,
      expected: 23_600,
      difference: 500,
      advancePaise: 0,
      unallocatedPaise: 1_000,
    }),
  ],
});

const routes = (overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> => ({
  'GET /auth/me': () => json(OWNER),
  'GET /reconciliation/latest': () => json({ run: null }),
  ...overrides,
});

describe('ReconciliationPage', { timeout: 30_000 }, () => {
  it('runs the first check by hand and shows the books in balance', async () => {
    const { user, requests } = renderApp({
      path: '/accounting/reconciliation',
      routes: routes({ 'POST /reconciliation/runs': () => json(run(), 201) }),
    });
    expect(await screen.findByRole('heading', { name: 'Reconciliation', level: 1 })).toBeVisible();
    expect(
      await screen.findByText(
        'Not checked yet. The books are checked every night, or run the check now.',
      ),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText('Books checked')).toBeVisible();
    expect(
      screen.getByText(
        'Everything agrees: stock, party balances and payments match their entries.',
      ),
    ).toBeVisible();
    expect(screen.getByLabelText('About this check')).toHaveTextContent('Anil Kumar, by hand');
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('lists what the nightly check found, in units and in rupees', async () => {
    renderApp({
      path: '/accounting/reconciliation',
      routes: routes({ 'GET /reconciliation/latest': () => json({ run: NIGHTLY }) }),
    });
    expect(
      await screen.findByText(
        '3 figures disagree with their entries. Tell your software provider.',
      ),
    ).toBeVisible();
    expect(screen.getByLabelText('About this check')).toHaveTextContent('The nightly check');
    const table = screen.getByRole('table', { name: 'Disagreements found' });
    const [, stock, balance, allocation] = within(table).getAllByRole('row');
    expect(stock).toHaveTextContent('Stock on handAPX-1L · Apex Ultima 1 lAmeerpet1210.51.5');
    expect(balance).toHaveTextContent('Party balanceDeccan Contractors₹241.00₹236.00₹5.00');
    expect(allocation).toHaveTextContent(
      'Payments allocatedDeccan ContractorsAdvance held ₹0.00, not allocated ₹10.00₹241.00',
    );
  });

  it('shows failures, and is reached from the other accounting screens', async () => {
    let down = true;
    const { user } = renderApp({
      path: '/accounting/export',
      routes: routes({
        'GET /accounting-exports/preview': () => json(PREVIEW()),
        'GET /accounting-exports': () => json({ items: [], total: 0 }),
        'GET /reconciliation/latest': () =>
          down ? json({ message: 'Down' }, 500) : json({ run: null }),
        'POST /reconciliation/runs': () => json({ message: 'Try again later' }, 503),
      }),
    });
    await user.click(await screen.findByRole('link', { name: 'Reconciliation' }));
    expect(await screen.findByText('Could not load the latest check')).toBeVisible();
    down = false;
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText('Try again later')).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run now' })).toBeEnabled();
    });
  });
});
