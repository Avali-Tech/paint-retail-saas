import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Lead, LeadStage } from '../api/leads.js';
import {
  OWNER,
  json,
  profile,
  type FakeHandler,
  type FakeRequest,
} from '../test-support/fake-api.js';
import { page } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { leadSteps } from './lead-actions.js';
import { crmRoutes, lead, opportunity, sent } from './test-support/fixtures.js';

const location = () => screen.getByTestId('location').textContent;
const SALES = profile(['stores:read', 'parties:read', 'leads:read', 'leads:manage'], {
  role: { key: 'sales_executive', name: 'Sales Executive' },
  allStores: false,
  storeIds: ['store-hyd'],
});
const READER = profile(['stores:read', 'leads:read']);

const listQueries = (requests: FakeRequest[]) =>
  requests
    .filter((request) => request.path === '/leads')
    .map((request) => request.query.toString());

describe('leadSteps', () => {
  it('follows the API’s stage rules', () => {
    const steps = (stage: LeadStage, opportunityId: string | null = null) =>
      leadSteps({ stage, opportunityId }).map((step) =>
        step.kind === 'move' ? `move:${step.stage}` : step.kind,
      );
    expect(steps('new')).toEqual(['move:contacted', 'move:qualified', 'lose']);
    expect(steps('contacted')).toEqual(['move:new', 'move:qualified', 'lose']);
    expect(steps('qualified')).toEqual(['move:new', 'move:contacted', 'convert', 'win', 'lose']);
    expect(steps('lost')).toEqual(['reopen']);
    expect(steps('lost', 'opp-1')).toEqual([]);
    expect(steps('opportunity', 'opp-1')).toEqual([]);
    expect(steps('won')).toEqual([]);
  });
});

describe('LeadsPage', () => {
  it('lists leads and filters them by search, stage, source, store and assignee', async () => {
    const { user, requests } = renderApp({
      path: '/leads',
      routes: {
        ...crmRoutes(),
        'GET /leads': () =>
          json(
            page(
              [
                lead(),
                lead({
                  id: 'lead-2',
                  number: 'LD-000002',
                  stage: 'qualified',
                  estimatedValuePaise: null,
                  party: { id: 'party-2', name: 'Walk-in Ravi', phone: null },
                }),
              ],
              120,
            ),
          ),
      },
    });
    const table = await screen.findByRole('table', { name: 'Leads' });
    const rows = within(table).getAllByRole('row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'LeadCustomerStageSourceValueAssigned toUpdated',
      'LD-000001Repaint 4-floor officeApex Builders+919876543210 · HYDNewWalk-in₹8,50,000.00Anil Kumar2 Oct 2026',
      'LD-000002Repaint 4-floor officeWalk-in RaviHYDQualifiedWalk-in—Anil Kumar2 Oct 2026',
    ]);
    expect(screen.getByRole('link', { name: '+ Lead' })).toHaveAttribute('href', '/leads/new');
    expect(screen.getByRole('navigation', { name: 'Sales pages' })).toBeInTheDocument();

    await user.type(
      screen.getByRole('searchbox', { name: 'Search by number, title or customer' }),
      'apex',
    );
    await waitFor(() => {
      expect(listQueries(requests).at(-1)).toBe('q=apex&limit=50&offset=0');
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Stage' }), 'qualified');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Source' }), 'referral');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'store-hyd');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assigned to' }), 'member-2');
    await waitFor(() => {
      expect(listQueries(requests).at(-1)).toBe(
        'q=apex&stage=qualified&source=referral&storeId=store-hyd&assignedTo=member-2&limit=50&offset=0',
      );
    });
    // Inactive members are not offered, nor the signed-in member (who is "Me").
    expect(screen.queryByRole('option', { name: 'Old Hand' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Anil Kumar' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(location()).toContain('offset=50');
    });
  });

  it('says when there are no leads, and when none match', async () => {
    const { user } = renderApp({
      path: '/leads',
      routes: { ...crmRoutes(READER), 'GET /leads': () => json(page([])) },
    });
    expect(await screen.findByText('No leads yet')).toBeInTheDocument();
    // Only those who may change leads can add one; only those who see the team can pick someone.
    expect(screen.queryByRole('link', { name: '+ Lead' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Sita Sales' })).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assigned to' }), 'me');
    expect(await screen.findByText('No leads match these filters')).toBeInTheDocument();
  });
});

const BOARD_TOTALS = [
  { stage: 'new', count: 1, valuePaise: 85_000_000 },
  { stage: 'contacted', count: 0, valuePaise: 0 },
  { stage: 'qualified', count: 60, valuePaise: 1_25_00_00_000 },
  { stage: 'opportunity', count: 1, valuePaise: 50_000 },
  { stage: 'won', count: 0, valuePaise: 0 },
  // "lost" left out: shown as none.
];

function renderBoard(member = OWNER, extra: Record<string, FakeHandler> = {}) {
  const byStage: Partial<Record<LeadStage, Lead[]>> = {
    new: [lead()],
    qualified: [
      lead({ id: 'lead-q', number: 'LD-000007', stage: 'qualified', estimatedValuePaise: null }),
    ],
    opportunity: [
      lead({ id: 'lead-o', number: 'LD-000008', stage: 'opportunity', opportunityId: 'opp-1' }),
    ],
    lost: [lead({ id: 'lead-l', number: 'LD-000009', stage: 'lost', lostReason: 'Price' })],
  };
  return renderApp({
    path: '/leads/board',
    routes: {
      ...crmRoutes(member),
      'GET /leads/pipeline': () => json(BOARD_TOTALS),
      'GET /leads': (request) => {
        const items = byStage[request.query.get('stage') as LeadStage] ?? [];
        return json(page(items, request.query.get('stage') === 'qualified' ? 60 : items.length));
      },
      'POST /leads/:id/stage': () => json(lead({ stage: 'contacted' })),
      'POST /leads/:id/win': () => json(lead({ stage: 'won' })),
      'POST /leads/:id/reopen': () => json(lead({ stage: 'contacted' })),
      'POST /leads/:id/lose': () => json(lead({ stage: 'lost' })),
      'POST /leads/:id/convert': () => json(opportunity()),
      'GET /opportunities/:id': () => json(opportunity()),
      ...extra,
    },
  });
}

const column = (name: string) => screen.getByRole('region', { name });

describe('LeadBoardPage', () => {
  it('groups leads by stage with counts and values in lakh and crore', async () => {
    renderBoard();
    await screen.findByText('LD-000001 · Repaint 4-floor office');
    expect(column('New')).toHaveTextContent('1 · ₹8.5 L');
    expect(column('Qualified')).toHaveTextContent('60 · ₹1.25 Cr');
    expect(column('Became an opportunity')).toHaveTextContent('1 · ₹500');
    expect(column('Lost')).toHaveTextContent('0 · ₹0');
    expect(within(column('Contacted')).getByText('None')).toBeInTheDocument();
    expect(
      within(column('New')).getByText('Apex Builders · ₹8.5 L · Anil Kumar'),
    ).toBeInTheDocument();
    expect(
      within(column('Qualified')).getByRole('link', { name: '59 more in the list' }),
    ).toHaveAttribute('href', '/leads?stage=qualified');
    // Converted leads move on as opportunities: nothing to do from here.
    expect(within(column('Became an opportunity')).queryByRole('button')).toBeNull();
  });

  it('moves a lead to another stage from its menu', async () => {
    const { user, requests } = renderBoard();
    await user.click(await screen.findByRole('button', { name: 'Move LD-000001' }));
    const menu = screen.getByRole('dialog', { name: 'Move LD-000001' });
    expect(
      within(menu)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Move to Contacted', 'Move to Qualified', 'Mark lost']);
    await user.click(within(menu).getByRole('button', { name: 'Move to Contacted' }));
    expect(await screen.findByText('LD-000001 moved to Contacted')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/leads/lead-1/stage')).toEqual({ stage: 'contacted' });
  });

  it('wins, reopens and loses leads, and shows a refusal', async () => {
    const { user, requests } = renderBoard(OWNER, {
      'POST /leads/:id/reopen': () =>
        json({ statusCode: 409, message: 'Its opportunity was lost' }, 409),
    });
    await user.click(await screen.findByRole('button', { name: 'Move LD-000007' }));
    await user.click(screen.getByRole('button', { name: 'Mark won' }));
    expect(await screen.findByText('LD-000007 won')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/leads/lead-q/win')).toEqual({});

    await user.click(screen.getByRole('button', { name: 'Move LD-000009' }));
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByText('That did not work')).toBeInTheDocument();
    expect(screen.getByText('Its opportunity was lost')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Move LD-000001' }));
    await user.click(screen.getByRole('button', { name: 'Mark lost' }));
    const dialog = screen.getByRole('dialog', { name: 'Why was LD-000001 lost?' });
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Bought elsewhere');
    await user.click(within(dialog).getByRole('button', { name: 'Mark lost' }));
    expect(await screen.findByText('LD-000001 marked lost')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/leads/lead-1/lose')).toEqual({ reason: 'Bought elsewhere' });
  });

  it('reopens a lost lead', async () => {
    const { user, requests } = renderBoard();
    await user.click(await screen.findByRole('button', { name: 'Move LD-000009' }));
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByText('LD-000009 reopened')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/leads/lead-l/reopen')).toEqual({});
  });

  it('converts a qualified lead into an opportunity', async () => {
    const { user, requests } = renderBoard();
    await user.click(await screen.findByRole('button', { name: 'Move LD-000007' }));
    await user.click(screen.getByRole('button', { name: 'Convert to opportunity' }));
    const dialog = screen.getByRole('dialog', { name: 'Convert LD-000007 to an opportunity' });
    const value = within(dialog).getByRole('textbox', { name: /Expected value/ });
    const chance = within(dialog).getByRole('textbox', { name: 'Chance of winning (%)' });
    const title = within(dialog).getByRole('textbox', { name: /Title/ });
    const convert = within(dialog).getByRole('button', { name: 'Convert' });
    await user.click(convert);
    expect(within(dialog).getByText('Enter the expected value in rupees')).toBeVisible();
    await user.type(value, '-5');
    await user.click(convert);
    expect(within(dialog).getByText('Enter the expected value in rupees')).toBeVisible();
    await user.clear(value);
    await user.type(value, '4,50,000');
    await user.clear(chance);
    await user.type(chance, '120');
    await user.click(convert);
    expect(within(dialog).getByText('Enter a chance from 0 to 100')).toBeVisible();
    await user.clear(chance);
    await user.type(chance, '40');
    await user.clear(title);
    await user.type(title, 'ab');
    await user.click(convert);
    expect(within(dialog).getByText('Enter a title of at least 3 characters')).toBeVisible();
    await user.type(title, 'c office');
    fireEvent.change(within(dialog).getByLabelText('Expected order date'), {
      target: { value: '2026-12-31' },
    });
    await user.click(convert);
    expect(await screen.findByText('Opportunity OP-000001 created')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/leads/lead-q/convert')).toEqual({
      title: 'abc office',
      expectedValuePaise: 45_000_000,
      probability: 40,
      expectedOrderDate: '2026-12-31',
    });
    await waitFor(() => {
      expect(location()).toBe('/opportunities/opp-1');
    });
  });

  it('converts with the lead’s estimate and no order date', async () => {
    const { user, requests } = renderBoard(OWNER, {
      'GET /leads': (request: FakeRequest) =>
        json(
          page(
            request.query.get('stage') === 'qualified'
              ? [
                  lead({
                    id: 'lead-q',
                    number: 'LD-000007',
                    stage: 'qualified',
                    expectedOrderDate: null,
                  }),
                ]
              : [],
          ),
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Move LD-000007' }));
    await user.click(screen.getByRole('button', { name: 'Convert to opportunity' }));
    const dialog = screen.getByRole('dialog', { name: 'Convert LD-000007 to an opportunity' });
    await user.click(within(dialog).getByRole('button', { name: 'Convert' }));
    expect(await screen.findByText('Opportunity OP-000001 created')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/leads/lead-q/convert')).toEqual({
      title: 'Repaint 4-floor office',
      expectedValuePaise: 85_000_000,
      probability: 20,
    });
  });

  it('filters the board by store and assignee', async () => {
    const { user, requests } = renderBoard();
    await screen.findByText('LD-000001 · Repaint 4-floor office');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'store-pun');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assigned to' }), 'me');
    await waitFor(() => {
      expect(
        requests
          .filter((request) => request.path === '/leads/pipeline')
          .at(-1)
          ?.query.toString(),
      ).toBe('storeId=store-pun&assignedTo=me');
    });
    expect(listQueries(requests).at(-1)).toBe(
      'stage=lost&storeId=store-pun&assignedTo=me&limit=50',
    );
  });

  it('shows the board without actions to those who only read leads', async () => {
    renderBoard(READER);
    await screen.findByText('LD-000001 · Repaint 4-floor office');
    expect(screen.queryByRole('button', { name: /^Move/ })).toBeNull();
    expect(screen.queryByRole('link', { name: '+ Lead' })).toBeNull();
  });

  it('lets a sales executive add a lead from the board', async () => {
    renderBoard(SALES);
    expect(await screen.findByRole('link', { name: '+ Lead' })).toHaveAttribute(
      'href',
      '/leads/new',
    );
  });
});
