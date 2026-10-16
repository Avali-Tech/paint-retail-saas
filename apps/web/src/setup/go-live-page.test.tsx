import type { GoLivePreview } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { addDays, todayInIndia } from '../lib/india-time.js';
import { OWNER, json, type FakeRequest } from '../test-support/fake-api.js';
import { BARE_PARTY, PARTY } from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { mergeOpenings, openingTotals, type OpeningEntry } from './GoLivePage.js';

const today = todayInIndia();
const earlier = addDays(today, -10);

const PREVIEW: GoLivePreview = {
  billingLiveOn: null,
  live: false,
  stockPostOn: 'invoice',
  openings: [
    {
      partyId: PARTY.id,
      partyName: 'Apex Builders',
      manualExposurePaise: 0,
      overdueDays: 0,
      amountPaise: 4_500_050,
      overdueSince: '2026-03-16',
      source: 'import',
    },
    {
      partyId: 'party-farhan',
      partyName: 'Farhan Ali',
      manualExposurePaise: 200_000,
      overdueDays: 4,
      amountPaise: 200_000,
      overdueSince: '2026-03-20',
      source: 'manual',
    },
    {
      partyId: 'party-gstin',
      partyName: 'GSTIN Traders',
      manualExposurePaise: 0,
      overdueDays: 0,
      amountPaise: 0,
      overdueSince: null,
      source: 'import',
    },
  ],
  loyaltyAccounts: 3,
  posted: null,
};

const LIVE: GoLivePreview = {
  ...PREVIEW,
  billingLiveOn: '2026-04-01',
  live: true,
  openings: [],
  posted: { entries: 2, totalPaise: 4_700_050 },
};

function goLive(options: { live?: boolean } = {}) {
  let live = options.live ?? false;
  const posts: FakeRequest[] = [];
  const rendered = renderApp({
    path: '/settings/go-live',
    routes: {
      'GET /auth/me': () => json(OWNER),
      'GET /sales/go-live': () => json(live ? LIVE : PREVIEW),
      'GET /parties': () => json({ items: [PARTY, BARE_PARTY], total: 2 }),
      'POST /sales/go-live': (request) => {
        posts.push(request);
        live = true;
        return json({ billingLiveOn: today, openingEntries: 2, openingTotalPaise: 4_700_050 });
      },
    },
  });
  return { ...rendered, posts };
}

describe('mergeOpenings and openingTotals', () => {
  it('lays this page’s changes over the API’s openings and counts what is owed', () => {
    const changed = {
      partyId: 'party-farhan',
      partyName: 'Farhan Ali',
      amountPaise: 0,
      overdueSince: '2026-03-20',
      source: 'here',
    } as const;
    const added = {
      partyId: 'party-new',
      partyName: 'New',
      amountPaise: 700,
      overdueSince: null,
      source: 'here',
    } as const;
    const merged = mergeOpenings(
      PREVIEW.openings,
      new Map<string, OpeningEntry>([
        [changed.partyId, changed],
        [added.partyId, added],
      ]),
    );
    expect(merged.map((entry) => [entry.partyName, entry.amountPaise])).toEqual([
      ['Apex Builders', 4_500_050],
      ['Farhan Ali', 0],
      ['GSTIN Traders', 0],
      ['New', 700],
    ]);
    expect(openingTotals(merged)).toEqual({ customers: 2, totalPaise: 4_500_750, overdue: 1 });
  });
});

describe('GoLivePage (PO-100)', { timeout: 30_000 }, () => {
  it('shows the openings, what blank overdue dates mean, and the totals', async () => {
    goLive();
    const table = await screen.findByRole('table', { name: 'Opening balances' });
    const [, apex, farhan, gstin] = within(table).getAllByRole('row');
    expect(apex).toHaveTextContent('Apex BuildersImported₹45,000.5016 Mar 2026');
    expect(farhan).toHaveTextContent('Farhan AliEntered on the credit panel₹2,000.0020 Mar 2026');
    expect(gstin).toHaveTextContent('GSTIN TradersImported₹0.00Not overdue');
    expect(
      screen.getByText(/the credit check and reminders treat the balance as current/),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Import opening balances' })).toHaveAttribute(
      'href',
      '/imports?kind=opening-balances',
    );
    const review = screen.getByRole('region', { name: '3. Review and go live' });
    expect(review).toHaveTextContent(
      'Customers with a balance2Total owed₹47,000.50Customers with an overdue date2Loyalty accounts whose manual purchase entry stops3',
    );
  });

  it('previews an earlier go-live date, and refuses a future one', async () => {
    const { user, requests } = goLive();
    const input = await screen.findByLabelText('Go live on');
    await user.clear(input);
    await user.type(input, earlier);
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('liveOn')).toBe(earlier);
    });

    await user.clear(input);
    await user.type(input, addDays(today, 1));
    expect(await screen.findByText('Choose today or an earlier day')).toBeVisible();
    expect(screen.getByRole('button', { name: /^Go live on/ })).toBeDisabled();
  });

  it('corrects an opening, checking the amount and the overdue date', async () => {
    const { user } = goLive();
    await user.click(
      await screen.findByRole('button', { name: 'Edit the opening balance of Apex Builders' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Opening balance: Apex Builders' });
    const amount = within(dialog).getByRole('textbox', { name: /^Owed on the go-live day/ });
    const overdue = within(dialog).getByLabelText('Overdue since');
    const save = within(dialog).getByRole('button', { name: 'Use this balance' });
    const problem = async (message: string) => {
      await user.click(save);
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    };

    await user.clear(amount);
    await user.type(amount, 'lots');
    await problem('Enter an amount in rupees, such as 1250.50');
    await user.clear(amount);
    await user.type(amount, '-5');
    await problem('Enter an amount in rupees, such as 1250.50');
    await user.clear(amount);
    await user.type(amount, '0');
    await problem('Only for a customer who owes something');
    await user.clear(amount);
    await user.type(amount, '40000');
    await user.clear(overdue);
    await user.type(overdue, addDays(today, 1));
    await problem('Choose today or an earlier day');
    await user.clear(overdue);
    await user.click(save);

    const table = screen.getByRole('table', { name: 'Opening balances' });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent(
      'Apex BuildersChanged here₹40,000.00Not overdue',
    );
    expect(screen.getByText(/Changes made here are kept on this page only/)).toBeVisible();
  });

  it('adds a customer found by name, or opens one already listed', async () => {
    const { user } = goLive();
    await user.click(await screen.findByRole('button', { name: 'Add a customer' }));
    await user.type(
      within(screen.getByRole('dialog')).getByRole('searchbox', {
        name: 'Search by name, mobile or GSTIN',
      }),
      'Ra',
    );
    await user.click(await screen.findByRole('button', { name: 'Choose Walk-in Ramesh' }));
    const dialog = screen.getByRole('dialog', { name: 'Opening balance: Walk-in Ramesh' });
    const amount = within(dialog).getByRole('textbox', { name: /^Owed on the go-live day/ });
    expect(amount).toHaveValue('0.00');
    await user.clear(amount);
    await user.type(amount, '500');
    await user.type(within(dialog).getByLabelText('Overdue since'), earlier);
    await user.click(within(dialog).getByRole('button', { name: 'Use this balance' }));
    const table = screen.getByRole('table', { name: 'Opening balances' });
    expect(within(table).getAllByRole('row')[4]).toHaveTextContent(
      'Walk-in RameshChanged here₹500.00',
    );

    await user.click(screen.getByRole('button', { name: 'Add a customer' }));
    await user.type(
      within(screen.getByRole('dialog')).getByRole('searchbox', {
        name: 'Search by name, mobile or GSTIN',
      }),
      'Ap',
    );
    await user.click(await screen.findByRole('button', { name: 'Choose Apex Builders' }));
    expect(
      within(screen.getByRole('dialog', { name: 'Opening balance: Apex Builders' })).getByRole(
        'textbox',
        { name: /^Owed on the go-live day/ },
      ),
    ).toHaveValue('45000.50');
  });

  it('goes live only after the balances are confirmed as checked, once', async () => {
    const { user, posts } = goLive();
    await user.click(
      await screen.findByRole('button', { name: 'Edit the opening balance of Farhan Ali' }),
    );
    const edit = screen.getByRole('dialog', { name: 'Opening balance: Farhan Ali' });
    await user.clear(within(edit).getByLabelText('Overdue since'));
    await user.click(within(edit).getByRole('button', { name: 'Use this balance' }));

    await user.click(screen.getByRole('button', { name: /^Go live on/ }));
    const dialog = screen.getByRole('dialog', { name: /^Go live on .*\?$/ });
    expect(within(dialog).getByText(/This cannot be undone/)).toBeVisible();
    expect(within(dialog).getByText('2 opening balances, ₹47,000.50 in all.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Go live' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Tick the box once the balances are checked',
    );
    await user.click(
      within(dialog).getByRole('checkbox', {
        name: 'I have checked these opening balances against the old books',
      }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Go live' }));

    expect(await screen.findByRole('region', { name: 'Billing is live' })).toBeVisible();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      liveOn: today,
      openings: [{ partyId: 'party-farhan', amountPaise: 200_000, overdueSince: null }],
    });
    expect(posts[0]?.headers['Idempotency-Key']).toEqual(expect.any(String));
  });

  it('once live, shows the date and what was posted', async () => {
    goLive({ live: true });
    const card = await screen.findByRole('region', { name: 'Billing is live' });
    expect(card).toHaveTextContent('Billing went live on 1 Apr 2026.');
    expect(card).toHaveTextContent('Opening balances posted2 customers · ₹47,000.50');
    expect(within(card).getByRole('link', { name: 'Open receivables' })).toHaveAttribute(
      'href',
      '/receivables',
    );
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says when nothing is imported yet', async () => {
    renderApp({
      path: '/settings/go-live',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /sales/go-live': () => json({ ...PREVIEW, openings: [] }),
      },
    });
    expect(
      await screen.findByText('No opening balances yet. Import them, or add customers one by one.'),
    ).toBeVisible();
  });

  it('shows a failure', async () => {
    renderApp({
      path: '/settings/go-live',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /sales/go-live': () => json({ message: 'Database down' }, 503),
      },
    });
    expect(await screen.findByText('Could not load the go-live')).toBeVisible();
  });
});
