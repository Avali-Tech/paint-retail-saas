import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Member } from '../api/team.js';
import { CASHIER, OWNER, json, profile, type FakeRequest } from '../test-support/fake-api.js';
import {
  FOLLOW_UP,
  LEAD_FOLLOW_UP,
  RAVI,
  followUpPage,
} from '../test-support/follow-up-fixtures.js';
import { PARTY } from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { FOLLOW_UP_PAGE_SIZE } from './FollowUpsPage.js';

const member = (id: string, userId: string, fullName: string, isActive = true): Member => ({
  id,
  user: { id: userId, fullName, phone: null, email: null },
  role: { id: 'r1', key: 'sales_executive', name: 'Sales Executive' },
  allStores: true,
  storeIds: [],
  isActive,
  twoFactorEnabled: false,
});
const MEMBERS: Member[] = [
  member('member-1', 'user-1', 'Anil Kumar'),
  member(RAVI.memberId, 'user-2', 'Ravi Teja'),
  member('member-3', 'user-3', 'Gone Person', false),
];
const STORES = [
  {
    id: 'store-hyd',
    code: 'HYD',
    name: 'Hyderabad',
    type: 'store',
    city: null,
    state: null,
    gstin: null,
    isActive: true,
  },
];

const section = (name: string) => screen.getByRole('region', { name });
const followUpsFor = (request: FakeRequest) => {
  switch (request.query.get('when')) {
    case 'overdue':
      return json(followUpPage([FOLLOW_UP]));
    case 'today':
      return json(followUpPage([]));
    default:
      return json(followUpPage([LEAD_FOLLOW_UP]));
  }
};
const location = () => screen.getByTestId('location').textContent;

describe('FollowUpsPage', { timeout: 30_000 }, () => {
  it('shows my follow-ups by when they are due, and a colleague’s at a store for managers', async () => {
    const { user, requests } = renderApp({
      path: '/follow-ups',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /activities/follow-ups': followUpsFor,
        'GET /members': () => json(MEMBERS),
        'GET /stores': () => json(STORES),
      },
    });
    expect(await screen.findByRole('heading', { name: 'My follow-ups', level: 1 })).toBeVisible();
    const overdue = await screen.findByRole('region', { name: 'Overdue' });
    expect(await within(overdue).findByText('Call about the quote')).toBeVisible();
    expect(within(overdue).getByText('Overdue', { selector: '.ui-badge' })).toBeVisible();
    expect(within(overdue).getByText('Call · Due 5 Oct 2026, 11:00 am')).toBeVisible();
    expect(within(overdue).getByRole('link', { name: 'Apex Builders' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}`,
    );
    expect(
      within(overdue).getByRole('link', { name: 'Timeline of Apex Builders' }),
    ).toHaveAttribute('href', `/activities?recordType=party&recordId=${PARTY.id}`);
    expect(await within(section('Due today')).findByText('Nothing due today')).toBeVisible();
    const upcoming = section('Upcoming');
    expect(
      await within(upcoming).findByRole('link', { name: 'LD-000004 · Kondapur tower' }),
    ).toHaveAttribute('href', '/leads/lead-1');
    expect(screen.getByRole('link', { name: 'Activity timeline' })).toHaveAttribute(
      'href',
      '/activities',
    );
    expect(
      requests
        .filter((request) => request.path === '/activities/follow-ups')
        .map((request) => request.query.toString()),
    ).toEqual([
      'when=overdue&limit=20&offset=0',
      'when=today&limit=20&offset=0',
      'when=upcoming&limit=20&offset=0',
    ]);

    // Only active colleagues are offered; "Me" is the default.
    const assignee = screen.getByRole('combobox', { name: 'Assigned to' });
    expect(
      within(assignee)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Me', 'Everyone', 'Ravi Teja']);
    await user.selectOptions(assignee, 'Ravi Teja');
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Store' }),
      'HYD · Hyderabad',
    );
    await waitFor(() => {
      expect(location()).toBe(`/follow-ups?assignedTo=${RAVI.memberId}&storeId=store-hyd`);
    });
    expect(await within(section('Upcoming')).findByText('Assigned to Ravi Teja')).toBeVisible();
    expect(requests.at(-1)?.query.get('assignedTo')).toBe(RAVI.memberId);
    expect(requests.at(-1)?.query.get('storeId')).toBe('store-hyd');

    // Everyone's: the team's list, each with who it is assigned to.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assigned to' }), 'Everyone');
    expect(await screen.findByRole('heading', { name: 'Team follow-ups', level: 1 })).toBeVisible();
    expect(location()).toBe('/follow-ups?assignedTo=everyone&storeId=store-hyd');
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('assignedTo')).toBe('everyone');
    });
    expect(await within(section('Overdue')).findByText('Assigned to Anil Kumar')).toBeVisible();
  });

  it('marks a follow-up done with its outcome and the next step', async () => {
    const completions: unknown[] = [];
    const { user } = renderApp({
      path: '/follow-ups',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /activities/follow-ups': followUpsFor,
        'GET /members': () => json(MEMBERS),
        'GET /stores': () => json(STORES),
        'POST /activities/:id/complete': (request) => {
          completions.push(request.body);
          const next = (request.body as { next?: unknown }).next
            ? { ...FOLLOW_UP, id: 'next', dueAt: '2026-10-07T05:00:00.000Z' }
            : null;
          return json({ completed: { ...FOLLOW_UP, status: 'done' }, next });
        },
      },
    });
    await user.click(
      await screen.findByRole('button', { name: 'Mark “Call about the quote” done' }),
    );
    let dialog = screen.getByRole('dialog', { name: 'Done: Call about the quote' });
    await user.type(
      within(dialog).getByRole('textbox', { name: 'What happened' }),
      'Ordered 40 L Apex',
    );
    await user.click(within(dialog).getByRole('checkbox', { name: 'Schedule the next step' }));
    await user.click(within(dialog).getByRole('button', { name: 'Mark done' }));
    expect(await within(dialog).findByText('Choose a date and time')).toBeVisible();
    fireEvent.change(within(dialog).getByLabelText(/^Next step on/), {
      target: { value: '2026-10-07T10:30' },
    });
    await user.type(within(dialog).getByRole('textbox', { name: 'Next step' }), 'Confirm delivery');
    await user.click(within(dialog).getByRole('button', { name: 'Mark done' }));
    expect(
      await screen.findByText('Follow-up done; next step on 7 Oct 2026, 10:30 am'),
    ).toBeVisible();
    expect(completions[0]).toEqual({
      outcome: 'Ordered 40 L Apex',
      next: { dueAt: '2026-10-07T10:30:00+05:30', subject: 'Confirm delivery' },
    });

    await user.click(screen.getByRole('button', { name: 'Mark “Call about the quote” done' }));
    dialog = screen.getByRole('dialog', { name: 'Done: Call about the quote' });
    await user.click(within(dialog).getByRole('checkbox', { name: 'Schedule the next step' }));
    fireEvent.change(within(dialog).getByLabelText(/^Next step on/), {
      target: { value: '2026-10-08T09:00' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Mark done' }));
    await waitFor(() => {
      expect(completions).toHaveLength(2);
    });
    expect(completions[1]).toEqual({ next: { dueAt: '2026-10-08T09:00:00+05:30' } });

    await user.click(screen.getByRole('button', { name: 'Mark “Call about the quote” done' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Mark done' }));
    expect(await screen.findByText('Follow-up done')).toBeVisible();
    expect(completions[2]).toEqual({});
  });

  it('reschedules a follow-up in India time', async () => {
    const changes: unknown[] = [];
    const { user } = renderApp({
      path: '/follow-ups',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /activities/follow-ups': followUpsFor,
        'GET /members': () => json(MEMBERS),
        'GET /stores': () => json(STORES),
        'PATCH /activities/:id': (request) => {
          changes.push(request.body);
          return json({ ...FOLLOW_UP, dueAt: '2026-10-09T06:30:00.000Z' });
        },
      },
    });
    await user.click(
      await screen.findByRole('button', { name: 'Reschedule “Call about the quote”' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Reschedule: Call about the quote' });
    const time = within(dialog).getByLabelText(/^New date and time/);
    expect(time).toHaveValue('2026-10-05T11:00');
    fireEvent.change(time, { target: { value: '' } });
    await user.click(within(dialog).getByRole('button', { name: 'Reschedule' }));
    expect(await within(dialog).findByText('Choose a date and time')).toBeVisible();
    fireEvent.change(time, { target: { value: '2026-10-09T12:00' } });
    await user.click(within(dialog).getByRole('button', { name: 'Reschedule' }));
    expect(await screen.findByText('Moved to 9 Oct 2026, 12:00 pm')).toBeVisible();
    expect(changes).toEqual([{ dueAt: '2026-10-09T12:00:00+05:30' }]);
  });

  it('shows counter staff their own follow-ups without changing records they cannot', async () => {
    renderApp({
      path: '/follow-ups?assignedTo=member-2',
      routes: {
        'GET /auth/me': () => json(CASHIER),
        'GET /activities/follow-ups': followUpsFor,
      },
    });
    const overdue = await screen.findByRole('region', { name: 'Overdue' });
    expect(await within(overdue).findByText('Call about the quote')).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Assigned to' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Mark/ })).toBeNull();
    // A manager's filter in the address is ignored for them.
    expect(within(section('Overdue')).queryByText(/Anil Kumar/)).toBeNull();
  });

  it('pages a long list, hides timelines without access and shows failures', async () => {
    const { user, requests } = renderApp({
      path: '/follow-ups',
      routes: {
        'GET /auth/me': () => json(profile([])),
        'GET /activities/follow-ups': (request) =>
          request.query.get('when') === 'overdue'
            ? json(followUpPage([FOLLOW_UP], FOLLOW_UP_PAGE_SIZE + 5))
            : json({ message: 'Database down' }, 503),
      },
    });
    const overdue = await screen.findByRole('region', { name: 'Overdue' });
    expect(await within(overdue).findByText('Call about the quote')).toBeVisible();
    expect(within(overdue).getByText('25')).toBeVisible();
    expect(within(overdue).queryByRole('link', { name: /Timeline/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Activity timeline' })).toBeNull();
    expect(
      await within(section('Due today')).findByText('Could not load follow-ups'),
    ).toBeVisible();
    await user.click(within(overdue).getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('offset')).toBe('20');
    });
  });
});
