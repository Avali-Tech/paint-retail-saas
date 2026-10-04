import { SYSTEM_ROLES } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LoyaltySummary } from '../api/loyalty.js';
import { CASHIER, OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import {
  LEDGER,
  LOYALTY,
  LOYALTY_SETTINGS,
  NOT_ENROLLED,
  OVERVIEW,
  PARTY,
  loyaltyView,
} from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { EMPTY_VALUES, prepareAction } from './actions.js';
import { LEDGER_PAGE_SIZE } from './LoyaltyPanel.js';

const BRANCH_MANAGER = profile(
  SYSTEM_ROLES.find((role) => role.key === 'branch_manager')?.permissions,
  { role: { key: 'branch_manager', name: 'Branch Manager' }, allStores: false },
);
const STORE_EMPLOYEE = profile(['parties:read', 'loyalty:read'], {
  role: { key: 'store_employee', name: 'Store Employee' },
  allStores: false,
});

function renderLoyalty(
  loyalty: LoyaltySummary,
  routes: Record<string, FakeHandler> = {},
  member = OWNER,
) {
  return renderApp({
    path: `/parties/${PARTY.id}`,
    routes: {
      'GET /auth/me': () => json(member),
      'GET /parties/:id/overview': () => json({ ...OVERVIEW, credit: null, loyalty }),
      'GET /parties/:id/loyalty': () => json(loyaltyView()),
      ...routes,
    },
  });
}

const panel = () => screen.getByRole('region', { name: 'Loyalty points' });
const dialog = () => screen.getByRole('dialog');

describe('prepareAction', () => {
  const values = (changes: Partial<typeof EMPTY_VALUES>) => ({ ...EMPTY_VALUES, ...changes });

  it('checks a purchase: an amount in rupees and its bill number', () => {
    expect(prepareAction('purchase', values({ amount: 'x' }))).toEqual({
      problem: 'loyalty.invalid.amount',
    });
    expect(prepareAction('purchase', values({ amount: '0' }))).toEqual({
      problem: 'loyalty.invalid.amount',
    });
    expect(prepareAction('purchase', values({ amount: '1500', reference: ' ' }))).toEqual({
      problem: 'loyalty.invalid.reference',
    });
  });

  it('wants positive points to award or redeem, and any but zero to adjust, with a reason', () => {
    for (const points of ['', 'ten', '0', '-5', '10000001']) {
      expect(prepareAction('award', values({ points }))).toEqual({
        problem: 'loyalty.invalid.points',
      });
    }
    expect(prepareAction('adjust', values({ points: '0' }))).toEqual({
      problem: 'loyalty.invalid.adjustPoints',
    });
    expect(prepareAction('adjust', values({ points: '-20' }))).toEqual({
      problem: 'loyalty.invalid.reason',
    });
    expect('call' in prepareAction('redeem', values({ points: '50' }))).toBe(true);
  });
});

describe('LoyaltyPanel', { timeout: 30_000 }, () => {
  it('shows points, tier and expiry, with the history a page at a time', async () => {
    const pages: string[] = [];
    const { user } = renderLoyalty(LOYALTY, {
      'GET /parties/:id/loyalty': (request) => {
        pages.push(request.query.toString());
        return request.query.get('offset') === '0'
          ? json(loyaltyView(LEDGER, LEDGER_PAGE_SIZE + 3))
          : json(loyaltyView([], LEDGER_PAGE_SIZE + 3));
      },
    });
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
    const loyalty = panel();
    expect(within(loyalty).getByText('Active')).toBeVisible();
    expect(within(loyalty).getByText('1,200 points')).toBeVisible();
    expect(within(loyalty).getByText('Silver')).toBeVisible();
    expect(within(loyalty).getByText('Gold in 3,500 points')).toBeVisible();
    expect(within(loyalty).getByText('200 points on 31 Mar 2027')).toBeVisible();
    expect(within(loyalty).getByText('Sunita Rao')).toBeVisible();

    const history = await within(loyalty).findByRole('table', { name: 'Points history' });
    const rows = within(history).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('RedeemedGift voucher-300Sunita Rao');
    expect(rows[2]).toHaveTextContent('PurchaseINV-104₹1,50,000.00+1,500Sunita Rao');
    expect(rows[3]).toHaveTextContent('Expired0System');
    await user.click(within(loyalty).getByRole('button', { name: 'Next' }));
    expect(await within(loyalty).findByText('No points yet')).toBeVisible();
    expect(pages).toEqual(['limit=10&offset=0', 'limit=10&offset=10']);
  });

  it('records purchases, awards, redemptions and adjustments, and refreshes the points', async () => {
    const posted: [string, unknown][] = [];
    const record =
      (kind: string): FakeHandler =>
      (request) => {
        posted.push([kind, request.body]);
        return posted.length === 1
          ? json({ message: 'Only 1200 points are available' }, 409)
          : json(loyaltyView());
      };
    const { user } = renderLoyalty(LOYALTY, {
      'POST /parties/:id/loyalty/purchases': record('purchase'),
      'POST /parties/:id/loyalty/awards': record('award'),
      'POST /parties/:id/loyalty/redemptions': record('redeem'),
      'POST /parties/:id/loyalty/adjustments': record('adjust'),
    });
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });

    await user.click(within(panel()).getByRole('button', { name: 'Redeem points' }));
    await user.type(within(dialog()).getByRole('textbox', { name: 'Points' }), '5000');
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(await within(dialog()).findByText('Only 1200 points are available')).toBeVisible();
    const points = within(dialog()).getByRole('textbox', { name: 'Points' });
    await user.clear(points);
    await user.type(points, '100');
    await user.type(within(dialog()).getByRole('textbox', { name: 'Note (optional)' }), 'Cap');
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Points updated')).toBeVisible();

    await user.click(within(panel()).getByRole('button', { name: 'Record purchase' }));
    await user.type(within(dialog()).getByRole('textbox', { name: 'Purchase amount (₹)' }), '1500');
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(within(dialog()).getByText('Enter the bill or invoice number')).toBeVisible();
    await user.type(
      within(dialog()).getByRole('textbox', { name: 'Bill or invoice number' }),
      'INV-200',
    );
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    await user.click(within(panel()).getByRole('button', { name: 'Award points' }));
    await user.type(within(dialog()).getByRole('textbox', { name: 'Points' }), '250');
    await user.type(
      within(dialog()).getByRole('textbox', { name: 'Campaign (optional)' }),
      'Diwali',
    );
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    await user.click(within(panel()).getByRole('button', { name: 'Adjust points' }));
    expect(within(dialog()).getByText('Use a minus sign to take points away')).toBeVisible();
    await user.type(within(dialog()).getByRole('textbox', { name: 'Points' }), '-20');
    await user.type(within(dialog()).getByRole('textbox', { name: 'Reason' }), 'Double entry');
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    await user.click(within(panel()).getByRole('button', { name: 'Award points' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(posted).toEqual([
      ['redeem', { points: 5000 }],
      ['redeem', { points: 100, note: 'Cap' }],
      ['purchase', { manualPurchasePaise: 1500_00, reference: 'INV-200' }],
      ['award', { points: 250, campaign: 'Diwali' }],
      ['adjust', { points: -20, reason: 'Double entry' }],
    ]);
  });

  it('enrols a customer who is not in the programme yet, with a salesperson', async () => {
    const bodies: unknown[] = [];
    const { user } = renderLoyalty(NOT_ENROLLED, {
      'GET /members': () =>
        json([
          { id: 'm1', user: { fullName: 'Sunita Rao' }, role: { name: 'Sales' }, isActive: true },
          { id: 'm2', user: { fullName: 'Old Hand' }, role: { name: 'Sales' }, isActive: false },
        ]),
      'POST /parties/:id/loyalty': (request) => {
        bodies.push(request.body);
        return bodies.length === 1
          ? json({ message: 'This party already has a loyalty account' }, 409)
          : json(loyaltyView(), 201);
      },
    });
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
    expect(within(panel()).getByText('Not in the loyalty programme yet.')).toBeVisible();
    expect(within(panel()).queryByRole('table')).toBeNull();
    await user.click(within(panel()).getByRole('button', { name: 'Enrol in loyalty' }));
    expect(dialog()).toHaveTextContent(
      'Purchases, awards and redemptions are recorded from now on.',
    );
    await user.click(within(dialog()).getByRole('button', { name: 'Enrol' }));
    expect(
      await within(dialog()).findByText('This party already has a loyalty account'),
    ).toBeVisible();
    const salesperson = within(dialog()).getByRole('combobox', { name: 'Looked after by' });
    await within(salesperson).findByRole('option', { name: 'Sunita Rao · Sales' });
    expect(within(salesperson).queryByRole('option', { name: 'Old Hand · Sales' })).toBeNull();
    await user.selectOptions(salesperson, 'Sunita Rao · Sales');
    await user.click(within(dialog()).getByRole('button', { name: 'Enrol' }));
    expect(await screen.findByText('Enrolled in the loyalty programme')).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bodies).toEqual([{}, { assignedMemberId: 'm1' }]);
  });

  it('enrols without a salesperson for members who cannot see the team', async () => {
    let body: unknown;
    const { user, requests } = renderLoyalty(
      NOT_ENROLLED,
      {
        'POST /parties/:id/loyalty': (request) => {
          body = request.body;
          return json(loyaltyView(), 201);
        },
      },
      profile(['parties:read', 'loyalty:read', 'loyalty:manage']),
    );
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
    await user.click(within(panel()).getByRole('button', { name: 'Enrol in loyalty' }));
    expect(within(dialog()).queryByRole('combobox')).toBeNull();
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(within(panel()).getByRole('button', { name: 'Enrol in loyalty' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Enrol' }));
    expect(await screen.findByText('Enrolled in the loyalty programme')).toBeVisible();
    expect(body).toEqual({});
    expect(requests.some((request) => request.path === '/members')).toBe(false);
  });

  it('closes an account and reopens a closed one', async () => {
    const statuses: unknown[] = [];
    const closed: LoyaltySummary = {
      ...LOYALTY,
      account: {
        ...LOYALTY.account,
        id: 'acct-1',
        status: 'closed',
        assignedTo: null,
        createdAt: '2026-09-01T05:00:00.000Z',
      },
    };
    let current = LOYALTY;
    const { user } = renderLoyalty(LOYALTY, {
      'GET /parties/:id/overview': () => json({ ...OVERVIEW, credit: null, loyalty: current }),
      'PATCH /parties/:id/loyalty': (request) => {
        statuses.push(request.body);
        if (statuses.length === 1) return json({ message: 'Database down' }, 503);
        current = current === LOYALTY ? closed : LOYALTY;
        return json(loyaltyView());
      },
    });
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
    await user.click(within(panel()).getByRole('button', { name: 'Close account' }));
    expect(await screen.findByText('Database down')).toBeVisible();
    await user.click(within(panel()).getByRole('button', { name: 'Close account' }));
    expect(await screen.findByText('Loyalty account closed')).toBeVisible();
    expect(await within(panel()).findByText('Closed')).toBeVisible();
    expect(within(panel()).queryByRole('button', { name: 'Award points' })).toBeNull();
    await user.click(within(panel()).getByRole('button', { name: 'Reopen account' }));
    expect(await screen.findByText('Loyalty account reopened')).toBeVisible();
    expect(statuses).toEqual([{ status: 'closed' }, { status: 'closed' }, { status: 'active' }]);
  });

  it('offers only reopening on a closed account', async () => {
    renderLoyalty(
      {
        ...LOYALTY,
        account: {
          id: 'acct-1',
          status: 'closed',
          assignedTo: null,
          createdAt: '2026-09-01T05:00:00.000Z',
        },
        tier: null,
        nextTier: null,
        nextExpiry: null,
      },
      {},
      BRANCH_MANAGER,
    );
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
    expect(within(panel()).getByText('Closed')).toBeVisible();
    expect(within(panel()).getAllByText('—')).toHaveLength(4);
    expect(within(panel()).queryByRole('button', { name: 'Award points' })).toBeNull();
    expect(within(panel()).getByRole('button', { name: 'Reopen account' })).toBeVisible();
  });

  it('hides enrolling from read-only roles', async () => {
    renderLoyalty(NOT_ENROLLED, {}, STORE_EMPLOYEE);
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
    expect(within(panel()).queryByRole('button', { name: 'Enrol in loyalty' })).toBeNull();
  });

  it('shows a failure to load the history', async () => {
    renderLoyalty(LOYALTY, {
      'GET /parties/:id/loyalty': () => json({ message: 'Database down' }, 503),
    });
    expect(await screen.findByText('Could not load the points history')).toBeVisible();
  });
});

describe('LoyaltySettingsPage', { timeout: 30_000 }, () => {
  it('lets an all-store manager change the programme, with its tiers', async () => {
    const saved: unknown[] = [];
    const { user } = renderApp({
      path: '/settings/loyalty',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /loyalty-settings': () => json(LOYALTY_SETTINGS),
        'PUT /loyalty-settings': (request) => {
          saved.push(request.body);
          if (saved.length === 1) {
            return json(
              {
                statusCode: 400,
                message: 'Validation failed',
                issues: [{ path: 'expiryDays', message: 'Too long' }],
              },
              400,
            );
          }
          return saved.length === 2
            ? json(
                { message: 'Only members who work at every store can change the programme' },
                403,
              )
            : json(request.body);
        },
      },
    });
    const earn = await screen.findByRole('textbox', { name: 'Points earned' });
    const per = screen.getByRole('textbox', { name: 'For every (₹)' });
    const expiry = screen.getByRole('textbox', { name: 'Points expire after (days)' });
    const minimum = screen.getByRole('textbox', { name: 'Minimum points to redeem' });
    expect(earn).toHaveValue('1');
    expect(per).toHaveValue('100.00');
    expect(expiry).toHaveValue('365');
    expect(screen.getByRole('textbox', { name: 'Tier 2 name' })).toHaveValue('Gold');

    await user.clear(earn);
    await user.type(earn, '0');
    await user.clear(per);
    await user.type(per, '0.5');
    await user.clear(expiry);
    await user.type(expiry, 'never');
    await user.clear(minimum);
    await user.type(minimum, 'x');
    await user.click(screen.getByRole('button', { name: 'Add tier' }));
    await user.click(screen.getByRole('button', { name: 'Save programme' }));
    expect(await screen.findByText('Enter 1 to 1000 points')).toBeVisible();
    expect(screen.getByText('Enter an amount from ₹1 to ₹1,00,000')).toBeVisible();
    expect(screen.getByText('Enter 1 to 3650 days, or leave empty')).toBeVisible();
    expect(screen.getAllByText('Enter a whole number of points')).toHaveLength(2);
    expect(screen.getByText('Enter a name of up to 40 characters')).toBeVisible();

    await user.type(screen.getByRole('textbox', { name: 'Tier 3 name' }), 'gold');
    await user.type(screen.getByRole('textbox', { name: 'Tier 3 from points' }), '9000');
    await user.clear(earn);
    await user.type(earn, '2');
    await user.clear(per);
    await user.type(per, '50');
    await user.clear(expiry);
    await user.clear(minimum);
    await user.type(minimum, '0');
    await user.click(screen.getByRole('button', { name: 'Save programme' }));
    expect(await screen.findByText('Each tier needs its own name')).toBeVisible();

    await user.clear(screen.getByRole('textbox', { name: 'Tier 3 name' }));
    await user.type(screen.getByRole('textbox', { name: 'Tier 3 name' }), 'Platinum');
    await user.clear(screen.getByRole('textbox', { name: 'Tier 3 from points' }));
    await user.type(screen.getByRole('textbox', { name: 'Tier 3 from points' }), '5000');
    await user.click(screen.getByRole('button', { name: 'Save programme' }));
    expect(await screen.findByText('Each tier needs its own points threshold')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Remove tier 3' }));
    await user.click(screen.getByRole('button', { name: 'Save programme' }));
    expect(await screen.findByText('Too long')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save programme' }));
    expect(
      await screen.findByText('Only members who work at every store can change the programme'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save programme' }));
    expect(await screen.findByText('Loyalty programme saved')).toBeVisible();
    expect(saved[2]).toEqual({
      earnPoints: 2,
      earnPerPaise: 5000,
      expiryDays: null,
      minRedemptionPoints: 0,
      tiers: LOYALTY_SETTINGS.tiers,
    });
  });

  it('stops adding tiers at ten', async () => {
    const { user } = renderApp({
      path: '/settings/loyalty',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /loyalty-settings': () => json({ ...LOYALTY_SETTINGS, tiers: [], expiryDays: null }),
      },
    });
    await screen.findByRole('textbox', { name: 'Points earned' });
    const expiry = screen.getByRole('textbox', { name: 'Points expire after (days)' });
    expect(expiry).toHaveValue('');
    for (const days of ['0', '4000']) {
      await user.clear(expiry);
      await user.type(expiry, days);
      await user.click(screen.getByRole('button', { name: 'Save programme' }));
      expect(await screen.findByText('Enter 1 to 3650 days, or leave empty')).toBeVisible();
    }
    for (let tier = 0; tier < 10; tier += 1) {
      await user.click(screen.getByRole('button', { name: 'Add tier' }));
    }
    expect(screen.getByRole('textbox', { name: 'Tier 10 name' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add tier' })).toBeNull();
  });

  it('is read-only for store-level managers and roles without loyalty:manage', async () => {
    const { unmount } = renderApp({
      path: '/settings/loyalty',
      routes: {
        'GET /auth/me': () => json(BRANCH_MANAGER),
        'GET /loyalty-settings': () => json(LOYALTY_SETTINGS),
      },
    });
    expect(
      await screen.findByText('Only members who work at every store can change the programme.'),
    ).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Points earned' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save programme' })).toBeNull();
    unmount();

    renderApp({
      path: '/settings/loyalty',
      routes: {
        'GET /auth/me': () => json(STORE_EMPLOYEE),
        'GET /loyalty-settings': () => json(LOYALTY_SETTINGS),
      },
    });
    expect(
      await screen.findByText('Your role can see the programme but not change it.'),
    ).toBeVisible();
  });

  it('shows a failure to load, and is closed to roles without loyalty access', async () => {
    const { unmount } = renderApp({
      path: '/settings/loyalty',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /loyalty-settings': () => json({ message: 'Database down' }, 503),
      },
    });
    expect(await screen.findByText('Could not load the loyalty programme')).toBeVisible();
    unmount();
    renderApp({ path: '/settings/loyalty', routes: { 'GET /auth/me': () => json(CASHIER) } });
    expect(await screen.findByText('No access')).toBeVisible();
  });
});
