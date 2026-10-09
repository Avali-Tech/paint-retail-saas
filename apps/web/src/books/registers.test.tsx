import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import {
  AMP,
  CLOSED_SESSION,
  KKP,
  OPEN_SESSION,
  STORES,
  SUMMARY,
} from './test-support/books-fixtures.js';

const location = () => screen.getByTestId('location').textContent;
const print = vi.fn();

beforeEach(() => {
  vi.spyOn(window, 'print').mockImplementation(print);
});

afterEach(() => {
  vi.restoreAllMocks();
  print.mockClear();
});

const CASHIER = profile(['register:manage', 'stores:read'], {
  role: { key: 'store_employee', name: 'Store Employee' },
  allStores: false,
  storeIds: [AMP.id],
});

const routes = (overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> => ({
  'GET /auth/me': () => json(OWNER),
  'GET /stores': () => json(STORES),
  'GET /register-sessions': (request) =>
    request.query.get('storeId') === AMP.id
      ? json({
          items: [
            SUMMARY(),
            SUMMARY({
              id: 'session-0',
              status: 'closed',
              closedAt: '2026-10-07T14:30:00.000Z',
              variancePaise: -2_000,
            }),
            SUMMARY({
              id: 'session-00',
              registerCode: 'COUNTER-2',
              status: 'closed',
              closedAt: '2026-10-06T14:30:00.000Z',
              variancePaise: 0,
            }),
          ],
          total: 3,
        })
      : json({ items: [], total: 0 }),
  ...overrides,
});

describe('RegistersPage', { timeout: 30_000 }, () => {
  it('lists the store’s sessions with their variance and opens a register with a float', async () => {
    const { user, requests } = renderApp({
      path: '/registers',
      routes: routes({
        'POST /registers/:code/open': () => json({ ...OPEN_SESSION, id: 'session-2' }, 201),
        'GET /register-sessions/:id': () => json(OPEN_SESSION),
      }),
    });
    expect(await screen.findByRole('heading', { name: 'Day end', level: 1 })).toBeVisible();
    const table = await screen.findByRole('table', { name: 'Sessions' });
    const [, open, short, balanced] = within(table).getAllByRole('row');
    expect(open).toHaveTextContent('COUNTER-1Open');
    expect(within(found(open)).getByRole('link', { name: 'COUNTER-1' })).toHaveAttribute(
      'href',
      `/registers/${OPEN_SESSION.id}`,
    );
    expect(short).toHaveTextContent('Closed');
    expect(short).toHaveTextContent('-₹20.00');
    expect(balanced).toHaveTextContent('₹0.00');
    // Bills are made at stores, not at godowns or closed shops.
    const store = screen.getByRole('combobox', { name: 'Store' });
    expect(
      within(store)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['AMP · Ameerpet', 'KKP · Kukatpally']);

    const code = screen.getByRole('textbox', { name: /^Register/ });
    await user.clear(code);
    await user.type(code, 'counter 1');
    await user.type(screen.getByRole('textbox', { name: 'Opening float (₹)' }), '-5');
    await user.click(screen.getByRole('button', { name: 'Open register' }));
    expect(await screen.findByText('Use letters, digits and dashes, at most 20')).toBeVisible();
    expect(screen.getByText('Enter the float in rupees, such as 2000')).toBeVisible();

    await user.clear(code);
    await user.type(code, 'counter-2');
    await user.click(screen.getByRole('button', { name: 'Open register' }));
    expect(await screen.findByText('Enter the float in rupees, such as 2000')).toBeVisible();
    const float = screen.getByRole('textbox', { name: 'Opening float (₹)' });
    await user.clear(float);
    await user.type(float, '2000');
    await user.type(screen.getByRole('textbox', { name: 'Note' }), ' Morning ');
    await user.click(screen.getByRole('button', { name: 'Open register' }));
    await waitFor(() => {
      expect(location()).toBe('/registers/session-2');
    });
    const opened = requests.find((request) => request.method === 'POST');
    expect(opened?.path).toBe('/registers/COUNTER-2/open');
    expect(opened?.body).toEqual({ storeId: AMP.id, openingFloatPaise: 2_00_000, note: 'Morning' });
  });

  it('switches stores and shows why a register did not open', async () => {
    const { user, requests } = renderApp({
      path: '/registers',
      routes: routes({
        'POST /registers/:code/open': () =>
          json(
            { statusCode: 409, message: 'Register COUNTER-1 is already open at this store' },
            409,
          ),
      }),
    });
    await screen.findByRole('table', { name: 'Sessions' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), KKP.id);
    expect(await screen.findByText('No register has been opened at this store yet.')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Opening float (₹)' }), '0');
    await user.click(screen.getByRole('button', { name: 'Open register' }));
    expect(
      await screen.findByText('Register COUNTER-1 is already open at this store'),
    ).toBeVisible();
    expect(requests.find((request) => request.method === 'POST')?.body).toEqual({
      storeId: KKP.id,
      openingFloatPaise: 0,
    });
  });

  it('offers no store picker to a member of one store', async () => {
    renderApp({
      path: '/registers',
      routes: routes({ 'GET /auth/me': () => json(CASHIER) }),
    });
    await screen.findByRole('table', { name: 'Sessions' });
    expect(screen.queryByRole('combobox', { name: 'Store' })).toBeNull();
  });

  it('explains when the member works at no store, or the sessions do not load', async () => {
    const first = renderApp({
      path: '/registers',
      routes: routes({ 'GET /auth/me': () => json({ ...CASHIER, storeIds: [] }) }),
    });
    expect(
      await screen.findByText('You do not work at a store yet. Ask an owner to add you to one.'),
    ).toBeVisible();
    first.unmount();
    renderApp({
      path: '/registers',
      routes: routes({ 'GET /register-sessions': () => json({ message: 'Down' }, 500) }),
    });
    expect(await screen.findByText('Could not load the register sessions')).toBeVisible();
  });
});

describe('RegisterSessionPage', { timeout: 30_000 }, () => {
  it('shows the drawer, records a pay-in and closes with a ₹20 variance and a Z-report', async () => {
    let current = OPEN_SESSION;
    const { user, requests } = renderApp({
      path: `/registers/${OPEN_SESSION.id}`,
      routes: routes({
        'GET /register-sessions/:id': () => json(current),
        'POST /register-sessions/:id/movements': (request) => {
          const body = request.body as { amountPaise: number };
          if (body.amountPaise === 1_00) {
            return json({ statusCode: 409, message: 'This register session is closed' }, 409);
          }
          current = {
            ...OPEN_SESSION,
            movements: [
              ...OPEN_SESSION.movements,
              {
                id: 'move-2',
                kind: 'pay_in',
                amountPaise: 50_000,
                reason: 'Change from bank',
                createdByMemberId: 'member-1',
                createdAt: '2026-10-08T07:00:00.000Z',
              },
            ],
          };
          return json(current, 201);
        },
        'POST /register-sessions/:id/close': () => json(CLOSED_SESSION),
      }),
    });
    expect(
      await screen.findByRole('heading', { name: 'Register COUNTER-1', level: 1 }),
    ).toBeVisible();
    const summary = screen.getByRole('region', { name: 'Cash in the drawer' });
    expect(summary).toHaveTextContent('Opened byAnil Kumar');
    expect(summary).toHaveTextContent('Opening float₹2,000.00');
    expect(summary).toHaveTextContent('Cash received₹1,180.00');
    expect(summary).toHaveTextContent('Cash refunded₹100.00');
    expect(summary).toHaveTextContent('Pay-ins less pay-outs-₹50.00');
    expect(summary).toHaveTextContent('Expected cash₹3,030.00');
    expect(screen.getByRole('table', { name: 'Taken by mode' })).toHaveTextContent(
      'UPI₹590.00₹0.001',
    );
    expect(screen.getByRole('table', { name: 'Pay-ins and pay-outs' })).toHaveTextContent(
      'Pay-out₹50.00Tea and snacks',
    );

    const movement = screen.getByRole('form', { name: 'Record cash movement' });
    await user.click(within(movement).getByRole('button', { name: 'Record cash movement' }));
    expect(await screen.findByText('Enter an amount above zero')).toBeVisible();
    expect(screen.getByText('Say why the cash moved')).toBeVisible();
    await user.selectOptions(within(movement).getByRole('combobox', { name: 'Kind' }), 'pay_in');
    await user.type(within(movement).getByRole('textbox', { name: 'Amount (₹)' }), '1');
    await user.type(within(movement).getByRole('textbox', { name: 'Reason' }), 'Change from bank');
    await user.click(within(movement).getByRole('button', { name: 'Record cash movement' }));
    expect(await screen.findByText('This register session is closed')).toBeVisible();
    const amount = within(movement).getByRole('textbox', { name: 'Amount (₹)' });
    await user.clear(amount);
    await user.type(amount, '500');
    await user.click(within(movement).getByRole('button', { name: 'Record cash movement' }));
    expect(await screen.findByText('Cash movement recorded')).toBeVisible();
    expect(screen.getByRole('table', { name: 'Pay-ins and pay-outs' })).toHaveTextContent(
      'Pay-in₹500.00Change from bank',
    );
    expect(requests.filter((r) => r.path.endsWith('/movements')).at(-1)?.body).toEqual({
      kind: 'pay_in',
      amountPaise: 50_000,
      reason: 'Change from bank',
    });

    const close = screen.getByRole('form', { name: 'Count the cash and close' });
    await user.type(within(close).getByRole('textbox', { name: 'Number of ₹500.00' }), '6');
    await user.type(within(close).getByRole('textbox', { name: 'Number of ₹1.00' }), 'x');
    const tally = within(close).getByLabelText('The count');
    expect(tally).toHaveTextContent('Counted₹3,000.00');
    expect(await within(close).findByText('Enter a whole number')).toBeVisible();
    await user.click(within(close).getByRole('button', { name: 'Close register' }));
    expect(requests.some((r) => r.path.endsWith('/close'))).toBe(false);
    const coins = within(close).getByRole('textbox', { name: 'Number of ₹1.00' });
    await user.clear(coins);
    await user.type(coins, '10');
    expect(tally).toHaveTextContent(
      'Counted₹3,010.00Expected cash₹3,030.00VarianceShort by ₹20.00',
    );
    await user.type(
      within(close).getByRole('textbox', { name: 'Closing note' }),
      'Short by twenty',
    );
    await user.click(within(close).getByRole('button', { name: 'Close register' }));

    const report = await screen.findByRole('article', { name: 'Z-report' });
    expect(requests.find((r) => r.path.endsWith('/close'))?.body).toEqual({
      denominations: { '50000': 6, '100': 10 },
      countedCashPaise: 3_01_000,
      note: 'Short by twenty',
    });
    expect(screen.getByText('Register closed')).toBeVisible();
    expect(report).toHaveTextContent('AMP · Ameerpet');
    expect(report).toHaveTextContent('Closed byAnil Kumar');
    expect(report).toHaveTextContent('Pay-out · Tea and snacks₹50.00');
    expect(report).toHaveTextContent(
      'Expected cash₹3,030.00Counted₹3,010.00VarianceShort by ₹20.00',
    );
    expect(report).toHaveTextContent('₹500.00 × 6₹3,000.00₹1.00 × 10₹10.00');
    expect(report).toHaveTextContent('Cash₹1,080.00UPI₹590.00');
    expect(report).toHaveTextContent('Short by twenty');
    await user.click(screen.getByRole('button', { name: 'Print Z-report' }));
    expect(print).toHaveBeenCalledOnce();
    expect(screen.queryByRole('form', { name: 'Record cash movement' })).toBeNull();
  });

  it('shows why a register did not close', async () => {
    const { user } = renderApp({
      path: `/registers/${OPEN_SESSION.id}`,
      routes: routes({
        'GET /register-sessions/:id': () => json(OPEN_SESSION),
        'POST /register-sessions/:id/close': () =>
          json({ statusCode: 409, message: 'This register session is closed' }, 409),
      }),
    });
    const close = await screen.findByRole('form', { name: 'Count the cash and close' });
    await user.click(within(close).getByRole('button', { name: 'Close register' }));
    expect(await within(close).findByText('This register session is closed')).toBeVisible();
  });

  it('reports a closed session counted as a total, balanced or over', async () => {
    const quiet = {
      ...CLOSED_SESSION,
      denominations: null,
      movements: [],
      modeTotals: [],
      closingNote: null,
    };
    const first = renderApp({
      path: `/registers/${OPEN_SESSION.id}`,
      routes: routes({
        'GET /register-sessions/:id': () =>
          json({ ...quiet, countedCashPaise: 3_03_000, variancePaise: 0 }),
      }),
    });
    const report = await screen.findByRole('article', { name: 'Z-report' });
    expect(report).toHaveTextContent('VarianceBalanced');
    expect(screen.getByText('No payments in this session yet.')).toBeVisible();
    expect(screen.getByText('No cash moved in or out yet.')).toBeVisible();
    first.unmount();
    renderApp({
      path: `/registers/${OPEN_SESSION.id}`,
      routes: routes({
        'GET /register-sessions/:id': () =>
          json({ ...quiet, countedCashPaise: 3_03_500, variancePaise: 500 }),
      }),
    });
    expect(await screen.findByRole('article', { name: 'Z-report' })).toHaveTextContent(
      'Over by ₹5.00',
    );
  });

  it('shows a failure', async () => {
    renderApp({
      path: '/registers/session-x',
      routes: routes({ 'GET /register-sessions/:id': () => json({ message: 'Down' }, 500) }),
    });
    expect(await screen.findByText('Could not load the register session')).toBeVisible();
  });
});
