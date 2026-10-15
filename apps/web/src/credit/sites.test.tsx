import { SYSTEM_ROLES } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CreditSummary } from '../api/credit.js';
import { SITE, SITE_DETAIL } from '../test-support/approval-fixtures.js';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { CREDIT, OVERVIEW, PARTY, loyaltyView } from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { readSiteLimit } from './SiteAccounts.js';

const BRANCH_MANAGER = profile(
  SYSTEM_ROLES.find((role) => role.key === 'branch_manager')?.permissions,
  { role: { key: 'branch_manager', name: 'Branch Manager' }, allStores: false },
);
const SALES = profile(SYSTEM_ROLES.find((role) => role.key === 'sales_executive')?.permissions, {
  role: { key: 'sales_executive', name: 'Sales Executive' },
});
const dialog = () => screen.getByRole('dialog');

/** After go-live: ₹50,000 limit, ₹12,000 owed from the ledger and ₹3,000 of open orders. */
const LIVE: CreditSummary = {
  ...CREDIT,
  exposurePaise: 15_000_00,
  exposureSource: 'ledger',
  exposure: { balancePaise: 12_000_00, openOrdersPaise: 3_000_00, advancePaise: 500_00 },
  sites: [SITE],
};

function renderCredit(
  credit: CreditSummary,
  routes: Record<string, FakeHandler> = {},
  member = OWNER,
  projects: typeof OVERVIEW.projects = OVERVIEW.projects,
) {
  return renderApp({
    path: `/parties/${PARTY.id}`,
    routes: {
      'GET /auth/me': () => json(member),
      'GET /parties/:id/overview': () => json({ ...OVERVIEW, credit, loyalty: null, projects }),
      'GET /parties/:id/loyalty': () => json(loyaltyView()),
      ...routes,
    },
  });
}

const panel = () => screen.getByRole('region', { name: 'Credit' });

describe('readSiteLimit', () => {
  it('reads a site limit in rupees within the party’s', () => {
    expect(readSiteLimit('10,000', 50_000_00)).toBe(10_000_00);
    expect(readSiteLimit('0', 50_000_00)).toBe('invalid');
    expect(readSiteLimit('abc', 50_000_00)).toBe('invalid');
    expect(readSiteLimit('100000001', Number.MAX_SAFE_INTEGER)).toBe('invalid');
    expect(readSiteLimit('60,000', 50_000_00)).toBe('over');
  });
});

describe('the credit panel after go-live (P2-M09)', { timeout: 30_000 }, () => {
  it('shows live exposure with its parts, and no hand-entered balance', async () => {
    renderCredit(LIVE);
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
    const credit = panel();
    expect(credit).toHaveTextContent('Owes now (ledger and open orders)₹15,000.00');
    expect(credit).toHaveTextContent('Balance in the ledger₹12,000.00');
    expect(credit).toHaveTextContent('Open orders on credit₹3,000.00');
    expect(credit).toHaveTextContent('Advance (already deducted)₹500.00');
    expect(within(credit).queryByRole('button', { name: 'Update balance' })).toBeNull();
    const sites = within(credit).getByRole('table', { name: 'Site accounts' });
    expect(within(sites).getByRole('link', { name: 'Jubilee Hills villa' })).toHaveAttribute(
      'href',
      `/site-accounts/${SITE.id}`,
    );
    expect(sites).toHaveTextContent('Jubilee Hills villaPJ-000001₹10,000.00₹7,000.0070%Active');
  });

  it('explains an automatic hold and a waiver, and lets staff ask to release', async () => {
    const asked: unknown[] = [];
    const held: CreditSummary = {
      ...LIVE,
      status: 'on_hold',
      holdKind: 'auto',
      overdueWaivedUntil: '2026-10-20',
      sites: [],
      check: { ...CREDIT.check, decision: 'blocked', blockedBecause: 'on_hold' },
    };
    const { user } = renderCredit(
      held,
      {
        'POST /credit-approvals': (request) => {
          asked.push(request.body);
          return json({ id: 'ap-9', number: 'AP-000009' }, 201);
        },
      },
      BRANCH_MANAGER,
    );
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
    const credit = panel();
    expect(credit).toHaveTextContent(
      'Put on hold automatically: bills are overdue beyond the credit rules.',
    );
    expect(credit).toHaveTextContent('Overdue days do not block credit until 20 Oct 2026.');
    expect(credit).toHaveTextContent('No site accounts yet');
    expect(within(credit).queryByRole('button', { name: 'Release hold' })).toBeNull();
    expect(within(credit).queryByRole('button', { name: 'Add site account' })).toBeNull();
    await user.click(within(credit).getByRole('button', { name: 'Ask to release' }));
    await user.type(within(dialog()).getByRole('textbox', { name: /Why this sale/ }), 'Paid half');
    await user.click(within(dialog()).getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findByText('Asked for approval: AP-000009')).toBeVisible();
    expect(asked).toEqual([{ kind: 'release', partyId: PARTY.id, reason: 'Paid half' }]);
  });

  it('links a release waiting for approval', async () => {
    renderCredit(
      {
        ...LIVE,
        status: 'on_hold',
        holdKind: 'manual',
        pendingRelease: {
          id: 'ap-3',
          number: 'AP-000003',
          status: 'pending',
          level: null,
          requestedBy: { memberId: 'm2', name: 'Vikram Sales' },
          createdAt: '2026-10-08T06:00:00.000Z',
        },
      },
      {},
      SALES,
    );
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
    expect(
      within(panel()).getByRole('link', {
        name: 'AP-000003: release of the hold waiting for approval',
      }),
    ).toHaveAttribute('href', '/credit/approvals/ap-3');
    expect(within(panel()).queryByRole('button', { name: 'Ask to release' })).toBeNull();
    expect(within(panel()).queryByText(/Put on hold automatically/)).toBeNull();
  });

  it('adds a site account within the party’s limit, for a project it is on', async () => {
    const added: unknown[] = [];
    const project = {
      id: 'project-2',
      number: 'PJ-000002',
      name: 'Banjara Hills office',
      stage: 'execution',
      storeCode: 'HYD',
      city: 'Hyderabad',
      roles: ['contractor'],
      updatedAt: '2026-10-01T06:00:00.000Z',
    };
    const { user } = renderCredit(
      LIVE,
      {
        'POST /parties/:id/sites': (request) => {
          added.push(request.body);
          return json(SITE, 201);
        },
      },
      OWNER,
      {
        total: 2,
        items: [
          { ...project, id: SITE.project.id, number: 'PJ-000001', name: 'Jubilee Hills villa' },
          project,
        ],
      },
    );
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
    await user.click(within(panel()).getByRole('button', { name: 'Add site account' }));
    expect(dialog()).toHaveTextContent('within the customer’s own limit of ₹50,000.00');
    // The site that already has an account is not offered again.
    expect(within(dialog()).getByRole('combobox', { name: 'Site (project)' })).toHaveTextContent(
      'PJ-000002 · Banjara Hills office',
    );
    await user.selectOptions(
      within(dialog()).getByRole('combobox', { name: 'Site (project)' }),
      'project-2',
    );
    const limit = within(dialog()).getByRole('textbox', { name: 'Site limit (₹)' });
    await user.click(within(dialog()).getByRole('button', { name: 'Add site account' }));
    expect(
      await within(dialog()).findByText(
        'Enter an amount in rupees, above zero and up to ₹10 crore',
      ),
    ).toBeVisible();
    await user.type(limit, '60000');
    await user.click(within(dialog()).getByRole('button', { name: 'Add site account' }));
    expect(
      await within(dialog()).findByText('A site’s limit is at most the customer’s: ₹50,000.00'),
    ).toBeVisible();
    await user.clear(limit);
    await user.type(limit, '20000');
    await user.click(within(dialog()).getByRole('button', { name: 'Add site account' }));
    expect(await screen.findByText('Site account added')).toBeVisible();
    await user.click(within(panel()).getByRole('button', { name: 'Add site account' }));
    await user.clear(within(dialog()).getByRole('textbox', { name: 'Site limit (₹)' }));
    await user.type(within(dialog()).getByRole('textbox', { name: 'Site limit (₹)' }), '5000');
    await user.type(within(dialog()).getByRole('textbox', { name: 'Notes' }), 'Phase 1');
    await user.click(within(dialog()).getByRole('button', { name: 'Add site account' }));
    await waitFor(() => {
      expect(added).toHaveLength(2);
    });
    expect(added).toEqual([
      { projectId: 'project-2', limitPaise: 20_000_00 },
      { projectId: 'project-2', limitPaise: 5_000_00, notes: 'Phase 1' },
    ]);
  });

  it('opens on a member who sees credit but not projects', async () => {
    renderCredit(LIVE, {}, profile(['parties:read', 'credit:read']), null);
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
    expect(within(panel()).getByRole('table', { name: 'Site accounts' })).toBeVisible();
  });
});

describe('SiteAccountPage', { timeout: 30_000 }, () => {
  it('shows the site’s position, ageing and ledger', async () => {
    renderApp({
      path: `/site-accounts/${SITE.id}`,
      routes: {
        'GET /auth/me': () => json(SALES),
        'GET /site-accounts/:id': () => json(SITE_DETAIL),
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Jubilee Hills villa · Site account', level: 1 }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Apex Builders' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}`,
    );
    const position = screen.getByRole('region', { name: 'Position' });
    expect(position).toHaveTextContent('Site limit₹10,000.00');
    expect(position).toHaveTextContent('Owes on the site₹7,000.00');
    expect(position).toHaveTextContent('NotesVilla repaint');
    expect(screen.getByRole('region', { name: 'Ageing' })).toHaveTextContent(
      'Not yet due₹2,000.00Up to 30 days₹0.00',
    );
    const [, open] = within(screen.getByRole('table', { name: 'Bills still unpaid' })).getAllByRole(
      'row',
    );
    expect(open).toHaveTextContent('HYD/26-27/0000012 Oct 20261 Nov 2026₹2,000.00Not yet due');
    const rows = within(screen.getByRole('table', { name: 'Site ledger' })).getAllByRole('row');
    expect(rows[2]).toHaveTextContent(
      '5 Oct 2026Payment RC-000004against HYD/26-27/000001-₹1,000.00₹2,000.00',
    );
    // A sales executive may put the site on hold, not release, change or close it.
    expect(screen.getByRole('button', { name: 'Put on hold' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Close account' })).toBeNull();
  });

  it('holds, releases, changes and closes a site account', async () => {
    let site = SITE_DETAIL;
    const calls: unknown[] = [];
    const { user } = renderApp({
      path: `/site-accounts/${SITE.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /site-accounts/:id': () => json(site),
        'POST /site-accounts/:id/hold': (request) => {
          calls.push(['hold', request.body]);
          site = {
            ...site,
            status: 'on_hold',
            hold: {
              reason: 'Disputed',
              at: '2026-10-09T06:00:00.000Z',
              by: { memberId: 'm1', name: 'Anil Kumar' },
            },
          };
          return json(site);
        },
        'POST /site-accounts/:id/release': () => {
          calls.push(['release']);
          site = { ...site, status: 'active', hold: null };
          return json(site);
        },
        'PATCH /site-accounts/:id': (request) => {
          calls.push(['edit', request.body]);
          return json(site);
        },
        'POST /site-accounts/:id/close': () => {
          calls.push(['close']);
          site = { ...site, status: 'closed', notes: null, ledger: [], openDocuments: [] };
          return json({ message: 'Closed already' }, calls.length > 5 ? 409 : 200);
        },
      },
    });
    await screen.findByRole('heading', { name: 'Jubilee Hills villa · Site account', level: 1 });
    await user.click(screen.getByRole('button', { name: 'Put on hold' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Put on hold' }));
    expect(
      await within(dialog()).findByText('Give a reason of at least 3 characters'),
    ).toBeVisible();
    await user.type(within(dialog()).getByRole('textbox', { name: 'Reason' }), 'Disputed');
    await user.click(within(dialog()).getByRole('button', { name: 'Put on hold' }));
    expect(await screen.findByText('Site put on hold')).toBeVisible();
    expect(await screen.findByRole('region', { name: 'Position' })).toHaveTextContent(
      'ReasonDisputed',
    );
    await user.click(screen.getByRole('button', { name: 'Release hold' }));
    expect(await screen.findByText('Site released')).toBeVisible();

    await user.click(await screen.findByRole('button', { name: 'Change limit' }));
    const limit = within(dialog()).getByRole('textbox', { name: 'Site limit (₹)' });
    expect(limit).toHaveValue('10000.00');
    await user.clear(limit);
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog()).findByText(
        'Enter an amount in rupees, above zero and up to ₹10 crore',
      ),
    ).toBeVisible();
    await user.type(limit, '20000');
    await user.clear(within(dialog()).getByRole('textbox', { name: 'Notes' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Site account saved')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Change limit' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));
    await user.click(screen.getByRole('button', { name: 'Close account' }));
    expect(await screen.findByText('Site account closed')).toBeVisible();
    expect(await screen.findByText('Nothing billed on this site yet')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Change limit' })).toBeNull();
    expect(calls).toEqual([
      ['hold', { reason: 'Disputed' }],
      ['release'],
      ['edit', { limitPaise: 20_000_00, notes: null }],
      ['edit', { limitPaise: 10_000_00, notes: 'Villa repaint' }],
      ['close'],
    ]);
  });

  it('shows a refused action and a failure to load', async () => {
    const first = renderApp({
      path: `/site-accounts/${SITE.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /site-accounts/:id': () =>
          json({
            ...SITE_DETAIL,
            status: 'on_hold',
            notes: null,
            hold: null,
            openDocuments: [{ ...SITE_DETAIL.openDocuments[0], dueOn: null }],
            ledger: [{ ...SITE_DETAIL.ledger[0], number: null }],
          }),
        'POST /site-accounts/:id/release': () =>
          json({ message: 'This site account is not on hold' }, 409),
      },
    });
    await first.user.click(await screen.findByRole('button', { name: 'Release hold' }));
    expect(await screen.findByText('This site account is not on hold')).toBeVisible();
    expect(screen.getByRole('table', { name: 'Bills still unpaid' })).toHaveTextContent('—');
    expect(screen.getByRole('table', { name: 'Site ledger' })).toHaveTextContent('Invoice ');
    await first.user.click(screen.getByRole('button', { name: 'Change limit' }));
    expect(within(dialog()).getByRole('textbox', { name: 'Notes' })).toHaveValue('');
    first.unmount();
    renderApp({
      path: `/site-accounts/${SITE.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /site-accounts/:id': () => json({ message: 'Not found' }, 404),
      },
    });
    expect(await screen.findByText('Could not load this site account')).toBeVisible();
  });
});
