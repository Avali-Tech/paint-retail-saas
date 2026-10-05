import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Opportunity } from '../api/leads.js';
import {
  activity,
  crmRoutes,
  opportunity,
  project,
  sent,
  type RecordOptions,
} from '../leads/test-support/fixtures.js';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import { page } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';

const location = () => screen.getByTestId('location').textContent;
const SALES = profile(['stores:read', 'parties:read', 'leads:read', 'leads:manage']);

const PIPELINE = [
  { stage: 'discovery', count: 3, valuePaise: 2_55_00_000, weightedValuePaise: 51_00_000 },
  { stage: 'proposal', count: 1, valuePaise: 3_00_00_00_000, weightedValuePaise: 1_50_00_00_000 },
  { stage: 'negotiation', count: 0, valuePaise: 0, weightedValuePaise: 0 },
  { stage: 'won', count: 2, valuePaise: 9_00_000, weightedValuePaise: 9_00_000 },
  { stage: 'lost', count: 0, valuePaise: 0, weightedValuePaise: 0 },
];

describe('OpportunitiesPage', () => {
  it('shows the pipeline and lists opportunities, filtered', async () => {
    const { user, requests } = renderApp({
      path: '/opportunities',
      routes: {
        ...crmRoutes(),
        'GET /opportunities/pipeline': () => json(PIPELINE),
        'GET /opportunities': () =>
          json(
            page(
              [
                opportunity(),
                opportunity({
                  id: 'opp-2',
                  number: 'OP-000002',
                  expectedOrderDate: null,
                  stage: 'won',
                  probability: 100,
                }),
              ],
              80,
            ),
          ),
      },
    });
    const strip = await screen.findByRole('list', { name: 'Pipeline by stage' });
    expect(
      within(strip)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Discovery · 3₹2.55 LWeighted ₹51,000',
      'Proposal · 1₹3 CrWeighted ₹1.5 Cr',
      'Negotiation · 0₹0Weighted ₹0',
      'Won · 2₹9,000Weighted ₹9,000',
      'Lost · 0₹0Weighted ₹0',
    ]);
    const table = await screen.findByRole('table', { name: 'Opportunities' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      'OpportunityCustomerStageValueChanceExpected orderSalesperson',
      'OP-000001Repaint 4-floor officeApex BuildersHYDDiscovery₹8,50,000.0020%15 Nov 2026Anil Kumar',
      'OP-000002Repaint 4-floor officeApex BuildersHYDWon₹8,50,000.00100%—Anil Kumar',
    ]);
    await user.type(screen.getByRole('searchbox', { name: /Search/ }), 'apex');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Stage' }), 'proposal');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'store-hyd');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assigned to' }), 'me');
    await waitFor(() => {
      expect(
        requests
          .filter((request) => request.path === '/opportunities')
          .at(-1)
          ?.query.toString(),
      ).toBe('q=apex&stage=proposal&storeId=store-hyd&assignedTo=me&limit=50&offset=0');
    });
    expect(
      requests
        .filter((request) => request.path === '/opportunities/pipeline')
        .at(-1)
        ?.query.toString(),
    ).toBe('storeId=store-hyd&assignedTo=me');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(location()).toContain('offset=50');
    });
  });

  it('says when there are none, and when none match', async () => {
    const { user } = renderApp({
      path: '/opportunities',
      routes: { ...crmRoutes(), 'GET /opportunities': () => json(page([])) },
    });
    expect(await screen.findByText('No opportunities yet')).toBeInTheDocument();
    // Without the pipeline totals the list still shows.
    expect(screen.queryByRole('list', { name: 'Pipeline by stage' })).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Stage' }), 'won');
    expect(await screen.findByText('No opportunities match these filters')).toBeInTheDocument();
  });
});

function renderOpportunity(
  shown: Opportunity,
  { member = OWNER, routes = {} }: RecordOptions = {},
) {
  return renderApp({
    path: `/opportunities/${shown.id}`,
    routes: {
      ...crmRoutes(member, [
        activity({ record: { type: 'opportunity', id: shown.id, label: shown.number } }),
      ]),
      'GET /opportunities/:id': () => json(shown),
      ...routes,
    },
  });
}

const details = () => screen.getByRole('region', { name: 'Details' });

describe('OpportunityDetailPage', () => {
  it('shows the value, chance, lead and activities', async () => {
    renderOpportunity(opportunity());
    expect(
      await screen.findByRole('heading', { name: 'OP-000001 · Repaint 4-floor office', level: 1 }),
    ).toBeVisible();
    expect(details()).toHaveTextContent('Expected value (₹)₹8,50,000.00');
    expect(details()).toHaveTextContent('Chance20%');
    expect(details()).toHaveTextContent('Weighted value₹1,70,000.00');
    expect(details()).toHaveTextContent('CategoryExterior emulsions');
    expect(within(details()).getByRole('link', { name: 'LD-000001' })).toHaveAttribute(
      'href',
      '/leads/lead-1',
    );
    expect(await screen.findByText('Discussed shades')).toBeInTheDocument();
  });

  it('moves between stages, and wins', async () => {
    const { user, requests } = renderOpportunity(opportunity(), {
      routes: {
        'POST /opportunities/:id/stage': () => json(opportunity({ stage: 'proposal' })),
        'POST /opportunities/:id/win': () => json(opportunity({ stage: 'won' })),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Move OP-000001' }));
    const menu = screen.getByRole('dialog', { name: 'Move OP-000001' });
    expect(
      within(menu)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Move to Proposal', 'Move to Negotiation', 'Mark won', 'Mark lost']);
    await user.click(within(menu).getByRole('button', { name: 'Move to Proposal' }));
    expect(await screen.findByText('OP-000001 moved')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/opportunities/opp-1/stage')).toEqual({ stage: 'proposal' });
    await user.click(screen.getByRole('button', { name: 'Move OP-000001' }));
    await user.click(screen.getByRole('button', { name: 'Mark won' }));
    expect(await screen.findByText('OP-000001 won')).toBeInTheDocument();
  });

  it('loses with a reason, and shows a refusal', async () => {
    let refuse = true;
    const { user, requests } = renderOpportunity(opportunity({ stage: 'negotiation' }), {
      routes: {
        'POST /opportunities/:id/win': () =>
          json({ statusCode: 409, message: 'This opportunity is won' }, 409),
        'POST /opportunities/:id/lose': () => {
          if (refuse) {
            refuse = false;
            return json({ statusCode: 409, message: 'This opportunity is lost' }, 409);
          }
          return json(opportunity({ stage: 'lost' }));
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Move OP-000001' }));
    await user.click(screen.getByRole('button', { name: 'Mark won' }));
    expect(await screen.findByText('This opportunity is won')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move OP-000001' }));
    await user.click(screen.getByRole('button', { name: 'Mark lost' }));
    const dialog = screen.getByRole('dialog', { name: 'Why was OP-000001 lost?' });
    expect(
      within(dialog).getByText('Its lead is closed as lost with the same reason.'),
    ).toBeVisible();
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Price too high');
    await user.click(within(dialog).getByRole('button', { name: 'Mark lost' }));
    expect(await within(dialog).findByText('This opportunity is lost')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Mark lost' }));
    expect(await screen.findByText('OP-000001 marked lost')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/opportunities/opp-1/lose')).toEqual({
      reason: 'Price too high',
    });
  });

  it('edits the value, chance and date', async () => {
    const { user, requests } = renderOpportunity(opportunity(), {
      routes: { 'PATCH /opportunities/:id': () => json(opportunity()) },
    });
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit OP-000001' });
    const title = within(dialog).getByRole('textbox', { name: /Title/ });
    const value = within(dialog).getByRole('textbox', { name: /Expected value/ });
    const chance = within(dialog).getByRole('textbox', { name: /Chance of winning/ });
    const save = within(dialog).getByRole('button', { name: 'Save' });
    await user.clear(title);
    await user.type(title, 'ab');
    await user.click(save);
    expect(within(dialog).getByText('Enter a title of at least 3 characters')).toBeVisible();
    await user.type(title, 'c');
    await user.clear(value);
    await user.click(save);
    expect(within(dialog).getByText('Enter the expected value in rupees')).toBeVisible();
    await user.type(value, '-1');
    await user.click(save);
    expect(within(dialog).getByText('Enter the expected value in rupees')).toBeVisible();
    await user.clear(value);
    await user.type(value, '9,00,000');
    await user.clear(chance);
    await user.type(chance, 'x');
    await user.click(save);
    expect(within(dialog).getByText('Enter a chance from 0 to 100')).toBeVisible();
    await user.clear(chance);
    await user.type(chance, '60');
    fireEvent.change(within(dialog).getByLabelText('Expected order date'), {
      target: { value: '' },
    });
    await user.click(save);
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(sent(requests, 'PATCH', '/opportunities/opp-1')).toEqual({
      title: 'abc',
      expectedValuePaise: 90_000_000,
      probability: 60,
      expectedOrderDate: null,
    });
  });

  it('reassigns the salesperson', async () => {
    const { user, requests } = renderOpportunity(opportunity({ expectedOrderDate: null }), {
      routes: { 'POST /opportunities/:id/assign': () => json(opportunity()) },
    });
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const edit = screen.getByRole('dialog', { name: 'Edit OP-000001' });
    expect(within(edit).getByLabelText('Expected order date')).toHaveValue('');
    await user.click(within(edit).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Reassign' }));
    const dialog = screen.getByRole('dialog', { name: 'Reassign OP-000001' });
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Assigned to' }),
      'member-2',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Assign' }));
    expect(await screen.findByText('Reassigned')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/opportunities/opp-1/assign')).toEqual({ memberId: 'member-2' });
  });

  it('starts the project for a won opportunity', async () => {
    let refuse = true;
    const { user } = renderOpportunity(
      opportunity({
        stage: 'won',
        probability: 100,
        closedAt: '2026-10-04T05:00:00.000Z',
        lead: null,
        category: null,
        expectedOrderDate: null,
      }),
      {
        routes: {
          'POST /opportunities/:id/project': () => {
            if (refuse) {
              refuse = false;
              return json(
                { statusCode: 409, message: 'This opportunity already has project PJ-000003' },
                409,
              );
            }
            return json(project());
          },
          'GET /projects/:id': () => json(project()),
        },
      },
    );
    await screen.findByRole('heading', { level: 1 });
    expect(details()).toHaveTextContent('Closed4 Oct 2026');
    expect(details()).not.toHaveTextContent('From lead');
    // Closed: nothing left to edit or move.
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move OP-000001' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Start project' }));
    expect(
      await screen.findByText('This opportunity already has project PJ-000003'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start project' }));
    expect(await screen.findByText('Project PJ-000001 started')).toBeInTheDocument();
    await waitFor(() => {
      expect(location()).toBe('/projects/project-1');
    });
  });

  it('links to its project, and shows a lost one to a sales executive', async () => {
    renderOpportunity(
      opportunity({
        stage: 'lost',
        lostReason: 'Price',
        project: { id: 'project-1', number: 'PJ-000001' },
      }),
      { member: SALES },
    );
    expect(await screen.findByRole('link', { name: 'Open PJ-000001' })).toHaveAttribute(
      'href',
      '/projects/project-1',
    );
    expect(details()).toHaveTextContent('Why it was lostPrice');
    expect(screen.queryByRole('button', { name: 'Start project' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reassign' })).toBeNull();
  });
});
