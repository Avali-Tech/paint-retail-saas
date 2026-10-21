import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Party } from '../api/parties.js';
import type { FakeRequest } from '../test-support/fake-api.js';
import { json, profile } from '../test-support/fake-api.js';
import { PARTY } from '../test-support/party-fixtures.js';
import { CASHIER_POS } from './test-support/pos-fixtures.js';
import { renderPos, scanBox } from './test-support/pos-render.js';

beforeEach(() => {
  vi.spyOn(window, 'print').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const RAVI: Party = {
  ...PARTY,
  id: 'party-ravi',
  displayName: 'Ravi Contractor',
  phone: '+919848012345',
  roles: ['customer'],
};
const RAMESH: Party = {
  ...PARTY,
  id: 'painter-1',
  displayName: 'Ramesh Painter',
  roles: ['painter'],
};
const LAKSHMI: Party = {
  ...PARTY,
  id: 'party-lakshmi',
  displayName: 'Lakshmi',
  roles: ['customer'],
};

/** Finds Ravi by mobile, and anyone else by name. */
const findParties = (request: FakeRequest) => {
  const q = String(request.query.get('q')).toLowerCase();
  const items = /^\d+$/.test(q)
    ? [RAVI]
    : [RAMESH, LAKSHMI].filter((party) => party.displayName.toLowerCase().includes(q));
  return json({ items, total: items.length });
};

/** Ravi's credit: this much is still free to owe. */
const overview = (availablePaise: number) => ({
  party: RAVI,
  credit: {
    status: 'active',
    limitPaise: 5_000_000,
    creditDays: 30,
    risk: 'low',
    manualExposurePaise: 0,
    overdueDays: 0,
    check: {
      decision: 'allowed',
      blockedBecause: null,
      projectedExposurePaise: 0,
      availablePaise,
      utilizationPercent: 0,
    },
    pendingRequest: null,
  },
  loyalty: null,
});

/** The body of the last draft saved for the bill. */
const lastDraft = (requests: readonly FakeRequest[]) =>
  requests
    .filter(
      (request) =>
        (request.method === 'POST' && request.path === '/invoices') ||
        (request.method === 'PUT' && request.path.startsWith('/invoices/')),
    )
    .at(-1)?.body as { influencerPartyId?: string } | undefined;

async function choosePainter(
  user: ReturnType<typeof renderPos>['user'],
  search: string,
  name: string,
) {
  // A refused choice leaves the picker open; the button would close it.
  if (screen.queryByRole('searchbox') === null) {
    await user.click(screen.getByRole('button', { name: /^(Choose|Change) Painter$/ }));
  }
  const box = screen.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' });
  await user.clear(box);
  await user.type(box, search);
  await user.click(await screen.findByRole('button', { name: `Choose ${name}` }));
}

async function findRavi(user: ReturnType<typeof renderPos>['user']) {
  await user.type(screen.getByRole('textbox', { name: 'Customer mobile' }), '9848012345');
  await user.click(screen.getByRole('button', { name: 'Find customer' }));
  await screen.findByText('Ravi Contractor · +919848012345');
}

describe('PosPage: the painter who sent the customer', () => {
  it('bills the painter’s points on a walk-in sale, and only to a painter', async () => {
    const { user, requests } = renderPos({ 'GET /parties': findParties });
    await user.type(await scanBox(), 'APX-20L{Enter}');
    await waitFor(() => {
      expect(screen.getByText('Bill saved')).toBeInTheDocument();
    });
    expect(lastDraft(requests)).not.toHaveProperty('influencerPartyId');

    await choosePainter(user, 'Lak', 'Lakshmi');
    expect(screen.getByText('Lakshmi is not a painter, contractor or architect')).toBeVisible();

    await choosePainter(user, 'Ram', 'Ramesh Painter');
    expect(screen.getByRole('textbox', { name: /^Painter/ })).toHaveValue('Ramesh Painter');
    await waitFor(() => {
      expect(lastDraft(requests)?.influencerPartyId).toBe('painter-1');
    });

    // Going back to walk-in keeps the painter: they are not the buyer.
    await findRavi(user);
    await user.click(screen.getByRole('button', { name: 'Walk-in instead' }));
    expect(screen.getByRole('textbox', { name: /^Painter/ })).toHaveValue('Ramesh Painter');

    await user.click(screen.getByRole('button', { name: 'Remove Painter' }));
    await waitFor(() => {
      expect(lastDraft(requests)).not.toHaveProperty('influencerPartyId');
    });
  });
});

describe('PosPage: the whole bill on account in one tap', () => {
  it('issues the bill unpaid on the customer’s account', async () => {
    let issued: unknown;
    const { user } = renderPos({
      'GET /parties': findParties,
      'GET /parties/:id/overview': () => json(overview(2_000_000)),
      'POST /invoices/:id/issue': (request) => {
        issued = request.body;
        return json({ message: 'stop here' }, 400);
      },
    });
    await user.type(await scanBox(), 'APX-20L{Enter}');
    await findRavi(user);
    await screen.findByText('Credit available: ₹20,000.00');
    await user.keyboard('{F8}');
    const pay = await screen.findByRole('dialog', { name: 'Payment' });
    await user.click(
      within(pay).getByRole('button', { name: /^Put all .+ on Ravi Contractor’s account$/ }),
    );
    await waitFor(() => {
      // No payments: the whole bill is owed (the client leaves `payments` out).
      expect(issued).toEqual({});
    });
  });

  it('offers it only to a customer with room for the whole bill', async () => {
    const { user } = renderPos({
      'GET /parties': findParties,
      'GET /parties/:id/overview': () => json(overview(100)),
    });
    await user.type(await scanBox(), 'APX-20L{Enter}');

    // A walk-in cannot owe.
    await user.keyboard('{F8}');
    let pay = await screen.findByRole('dialog', { name: 'Payment' });
    expect(within(pay).queryByRole('button', { name: /^Put all/ })).toBeNull();
    await user.keyboard('{Escape}');

    // ₹1.00 of credit is not enough for the bill.
    await findRavi(user);
    await screen.findByText('Credit available: ₹1.00');
    await user.keyboard('{F8}');
    pay = await screen.findByRole('dialog', { name: 'Payment' });
    expect(within(pay).queryByRole('button', { name: /^Put all/ })).toBeNull();
  });

  it('is not offered to a counter that cannot sell on account', async () => {
    const { user } = renderPos(
      {
        'GET /parties': findParties,
        'GET /parties/:id/overview': () => json(overview(2_000_000)),
      },
      profile(
        CASHIER_POS.permissions.filter((permission) => permission !== 'billing:on_account'),
        { role: CASHIER_POS.role, allStores: false, storeIds: [...CASHIER_POS.storeIds] },
      ),
    );
    await user.type(await scanBox(), 'APX-20L{Enter}');
    await findRavi(user);
    await screen.findByText('Credit available: ₹20,000.00');
    await user.keyboard('{F8}');
    const pay = await screen.findByRole('dialog', { name: 'Payment' });
    expect(within(pay).queryByRole('button', { name: /^Put all/ })).toBeNull();
  });
});
