import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Lead } from '../api/leads.js';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { activity, crmRoutes, lead, sent, type RecordOptions } from './test-support/fixtures.js';

const READER = profile(['stores:read', 'leads:read']);

function renderLead(
  shown: Lead,
  { member = OWNER, activities = [], routes = {} }: RecordOptions = {},
) {
  return renderApp({
    path: `/leads/${shown.id}`,
    routes: {
      ...crmRoutes(member, activities),
      'GET /leads/:id': () => json(shown),
      ...routes,
    },
  });
}

const details = () => screen.getByRole('region', { name: 'Details' });
const activitiesCard = () => screen.getByRole('region', { name: 'Activities' });

describe('LeadDetailPage', () => {
  it('shows the lead, its details and its activities', async () => {
    renderLead(lead({ referredBy: { id: 'party-4', name: 'Ritu Architects' } }), {
      activities: [
        activity({ notes: 'Wants Royale Aspira', outcome: 'Send quote' }),
        activity({
          id: 'activity-2',
          type: 'follow_up',
          subject: 'Call back',
          status: 'scheduled',
          dueAt: '2026-10-05T05:30:00.000Z',
          completedAt: null,
          overdue: true,
        }),
        activity({
          id: 'activity-3',
          type: 'visit',
          subject: 'Site visit',
          status: 'scheduled',
          dueAt: '2026-10-20T05:30:00.000Z',
          completedAt: null,
        }),
        activity({
          id: 'activity-4',
          type: 'note',
          subject: 'Dropped',
          status: 'cancelled',
          completedAt: null,
          cancelledAt: '2026-10-03T05:30:00.000Z',
        }),
      ],
    });
    expect(
      await screen.findByRole('heading', { name: 'LD-000001 · Repaint 4-floor office', level: 1 }),
    ).toBeVisible();
    expect(screen.getByText('Apex Builders · Hyderabad')).toBeInTheDocument();
    expect(within(details()).getByRole('link', { name: 'Apex Builders' })).toHaveAttribute(
      'href',
      '/parties/party-1',
    );
    expect(details()).toHaveTextContent('Referred byRitu Architects');
    expect(details()).toHaveTextContent('Estimated value (₹)₹8,50,000.00');
    expect(details()).toHaveTextContent('Expected order date15 Nov 2026');
    expect(details()).toHaveTextContent('Exterior emulsion, about 2,000 litres');
    expect(details()).not.toHaveTextContent('Closed');
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/leads/lead-1/edit',
    );

    const items = within(await within(activitiesCard()).findByRole('list')).getAllByRole(
      'listitem',
    );
    expect(items.map((item) => item.textContent)).toEqual([
      'Discussed shades Call2 Oct 2026, 11:30 am · Anil KumarWants Royale AspiraOutcome: Send quote',
      'Call back Follow-upOverdueDue 5 Oct 2026, 11:00 am · Anil Kumar',
      'Site visit VisitScheduledDue 20 Oct 2026, 11:00 am · Anil Kumar',
      'Dropped NoteCancelled2 Oct 2026, 11:30 am · Anil Kumar',
    ]);
    expect(
      within(activitiesCard()).getByRole('link', { name: 'See all activity' }),
    ).toHaveAttribute('href', '/activities?recordType=lead&recordId=lead-1');
  });

  it('shows a closed lead without the details it lacks, and nothing to change for readers', async () => {
    renderLead(
      lead({
        stage: 'lost',
        lostReason: 'Went with another dealer',
        closedAt: '2026-10-03T05:00:00.000Z',
        requirement: null,
        estimatedValuePaise: null,
        expectedOrderDate: null,
        party: { id: 'party-1', name: 'Apex Builders', phone: null },
      }),
      { member: READER },
    );
    expect(await screen.findByText('Why it was lost')).toBeInTheDocument();
    expect(details()).toHaveTextContent('Went with another dealer');
    expect(details()).toHaveTextContent('Closed3 Oct 2026');
    expect(details()).not.toHaveTextContent('Mobile');
    expect(details()).not.toHaveTextContent('Requirement');
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move LD-000001' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reassign' })).toBeNull();
    expect(
      await within(activitiesCard()).findByText('No calls, visits or notes yet'),
    ).toBeVisible();
    expect(within(activitiesCard()).queryByRole('button')).toBeNull();
  });

  it('links a converted lead to its opportunity, and lets it be reassigned', async () => {
    const { user, requests } = renderLead(lead({ stage: 'opportunity', opportunityId: 'opp-1' }), {
      routes: { 'POST /leads/:id/assign': () => json(lead()) },
    });
    expect(await screen.findByText('This lead became an opportunity.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the opportunity' })).toHaveAttribute(
      'href',
      '/opportunities/opp-1',
    );
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reassign' }));
    const dialog = screen.getByRole('dialog', { name: 'Reassign LD-000001' });
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Assigned to' }),
      'member-2',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Assign' }));
    expect(await screen.findByText('Reassigned')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/leads/lead-1/assign')).toEqual({ memberId: 'member-2' });
  });

  it('moves the lead from its page', async () => {
    const { user, requests } = renderLead(lead(), {
      routes: { 'POST /leads/:id/stage': () => json(lead({ stage: 'qualified' })) },
    });
    await user.click(await screen.findByRole('button', { name: 'Move LD-000001' }));
    await user.click(screen.getByRole('button', { name: 'Move to Qualified' }));
    expect(await screen.findByText('LD-000001 moved to Qualified')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/leads/lead-1/stage')).toEqual({ stage: 'qualified' });
  });

  it('logs a call and schedules a follow-up', async () => {
    const { user, requests } = renderLead(lead(), {
      routes: { 'POST /activities': () => json(activity()) },
    });
    const card = await screen.findByRole('region', { name: 'Activities' });
    await user.click(within(card).getByRole('button', { name: 'Log activity' }));
    let dialog = screen.getByRole('dialog', { name: 'Log a call, visit or note' });
    await user.click(within(dialog).getByRole('button', { name: 'Log activity' }));
    expect(within(dialog).getByText('Say what it was about (at least 2 characters)')).toBeVisible();
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Type' }), 'visit');
    expect(within(dialog).queryByRole('option', { name: 'Follow-up' })).toBeNull();
    await user.type(within(dialog).getByRole('textbox', { name: /What about/ }), 'Site visit');
    await user.type(within(dialog).getByRole('textbox', { name: 'Notes' }), 'Measured the hall');
    await user.type(within(dialog).getByRole('textbox', { name: 'Outcome' }), 'Quote tomorrow');
    await user.click(within(dialog).getByRole('button', { name: 'Log activity' }));
    expect(await screen.findByText('Activity logged')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/activities')).toEqual({
      recordType: 'lead',
      recordId: 'lead-1',
      type: 'visit',
      subject: 'Site visit',
      notes: 'Measured the hall',
      outcome: 'Quote tomorrow',
    });

    await user.click(within(card).getByRole('button', { name: 'Schedule follow-up' }));
    dialog = screen.getByRole('dialog', { name: 'Schedule a follow-up' });
    await user.type(within(dialog).getByRole('textbox', { name: /What about/ }), 'Call back');
    await user.click(within(dialog).getByRole('button', { name: 'Schedule follow-up' }));
    expect(within(dialog).getByText('Choose the date and time of the follow-up')).toBeVisible();
    fireEvent.change(within(dialog).getByLabelText(/^Date/), { target: { value: '2026-10-09' } });
    fireEvent.change(within(dialog).getByLabelText(/^Time/), { target: { value: '' } });
    await user.click(within(dialog).getByRole('button', { name: 'Schedule follow-up' }));
    expect(within(dialog).getByText('Choose the date and time of the follow-up')).toBeVisible();
    fireEvent.change(within(dialog).getByLabelText(/^Time/), { target: { value: '16:30' } });
    await user.click(within(dialog).getByRole('button', { name: 'Schedule follow-up' }));
    expect(await screen.findByText('Follow-up scheduled')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        requests
          .filter((request) => request.path === '/activities' && request.method === 'POST')
          .at(-1)?.body,
      ).toEqual({
        recordType: 'lead',
        recordId: 'lead-1',
        type: 'follow_up',
        subject: 'Call back',
        dueAt: '2026-10-09T16:30:00+05:30',
      });
    });

    // A follow-up can go to a colleague who can see the lead at its store.
    await user.click(within(card).getByRole('button', { name: 'Schedule follow-up' }));
    dialog = screen.getByRole('dialog', { name: 'Schedule a follow-up' });
    await user.type(within(dialog).getByRole('textbox', { name: /What about/ }), 'Measure up');
    fireEvent.change(within(dialog).getByLabelText(/^Date/), { target: { value: '2026-10-10' } });
    await user.selectOptions(
      await within(dialog).findByRole('combobox', { name: /Assigned to/ }),
      'member-2',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Schedule follow-up' }));
    await waitFor(() => {
      expect(
        requests
          .filter((request) => request.path === '/activities' && request.method === 'POST')
          .at(-1)?.body,
      ).toMatchObject({ subject: 'Measure up', assignedMemberId: 'member-2' });
    });
    expect(
      requests.find((request) => request.path === '/members/assignable')?.query.toString(),
    ).toBe('for=activity&recordType=lead&storeId=store-hyd');
  });

  it('logs a call with just a subject', async () => {
    const { user, requests } = renderLead(lead(), {
      routes: { 'POST /activities': () => json(activity()) },
    });
    const card = await screen.findByRole('region', { name: 'Activities' });
    await user.click(within(card).getByRole('button', { name: 'Log activity' }));
    const dialog = screen.getByRole('dialog', { name: 'Log a call, visit or note' });
    await user.type(within(dialog).getByRole('textbox', { name: /What about/ }), 'Quick call');
    await user.click(within(dialog).getByRole('button', { name: 'Log activity' }));
    expect(await screen.findByText('Activity logged')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/activities')).toEqual({
      recordType: 'lead',
      recordId: 'lead-1',
      type: 'call',
      subject: 'Quick call',
    });
  });

  it('says when the lead cannot be found', async () => {
    renderApp({ path: '/leads/missing', routes: crmRoutes() });
    expect(await screen.findByText('Could not load this lead')).toBeInTheDocument();
  });
});
