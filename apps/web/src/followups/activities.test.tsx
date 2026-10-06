import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Member } from '../api/team.js';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import {
  CANCELLED_NOTE,
  DONE_VISIT,
  FOLLOW_UP,
  LEAD_FOLLOW_UP,
  RAVI,
} from '../test-support/follow-up-fixtures.js';
import { PARTY } from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { TIMELINE_PAGE_SIZE } from './ActivitiesPage.js';

const TIMELINE = [FOLLOW_UP, DONE_VISIT, CANCELLED_NOTE];
const path = `/activities?recordType=party&recordId=${PARTY.id}`;
const location = () => screen.getByTestId('location').textContent;
const subjects = (container: HTMLElement) =>
  within(container)
    .queryAllByRole('listitem')
    .map((item) => item.querySelector('.record-list__title')?.firstChild?.textContent?.trim());
const member = (id: string, fullName: string, isActive = true): Member => ({
  id,
  user: { id: `user-${id}`, fullName, phone: null, email: null },
  role: { id: 'r1', key: 'sales_executive', name: 'Sales Executive' },
  allStores: true,
  storeIds: [],
  isActive,
  twoFactorEnabled: false,
});
const MEMBERS = [member(RAVI.memberId, RAVI.name), member('member-9', 'Gone Person', false)];
const lastQuery = (requests: { path: string; query: URLSearchParams }[]) =>
  requests
    .filter((request) => request.path === '/activities')
    .at(-1)
    ?.query.toString();

describe('ActivitiesPage', { timeout: 30_000 }, () => {
  it('lists activities across records, with filters the API applies', async () => {
    const { user, requests } = renderApp({
      path: '/activities',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /members': () => json(MEMBERS),
        'GET /activities': (request) =>
          request.query.get('type') === 'note'
            ? json({ items: [], total: 0 })
            : json({ items: [FOLLOW_UP, LEAD_FOLLOW_UP], total: 2 }),
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Activity timeline', level: 1 }),
    ).toBeVisible();
    await screen.findByText('Site visit');
    expect(lastQuery(requests)).toBe('limit=50&offset=0');
    // Each activity names its record, links to it and to its timeline.
    expect(screen.getByRole('link', { name: 'LD-000004 · Kondapur tower' })).toHaveAttribute(
      'href',
      '/leads/lead-1',
    );
    expect(screen.getByRole('link', { name: 'Timeline of Apex Builders' })).toHaveAttribute(
      'href',
      `/activities?recordType=party&recordId=${PARTY.id}`,
    );
    expect(screen.getAllByText(/^Customer or party ·/)).toHaveLength(1);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Record' }), 'Lead');
    await waitFor(() => {
      expect(lastQuery(requests)).toBe('recordType=lead&limit=50&offset=0');
    });
    const person = screen.getByRole('combobox', { name: 'Person' });
    // Only active colleagues are offered.
    expect(
      within(person)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Everyone', 'Me', 'Ravi Teja']);
    await user.selectOptions(person, 'Ravi Teja');
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: '2026-09-21' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-09-30' } });
    await waitFor(() => {
      expect(lastQuery(requests)).toBe(
        `recordType=lead&person=${RAVI.memberId}&from=2026-09-21&to=2026-09-30&limit=50&offset=0`,
      );
    });
    expect(location()).toBe(
      `/activities?recordType=lead&person=${RAVI.memberId}&from=2026-09-21&to=2026-09-30`,
    );

    // A backwards range is pointed out, and only the valid "from" date is sent.
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-09-01' } });
    expect(await screen.findByText('The “to” date cannot be before the “from” date')).toBeVisible();
    await waitFor(() => {
      expect(lastQuery(requests)).toBe(
        `recordType=lead&person=${RAVI.memberId}&from=2026-09-21&limit=50&offset=0`,
      );
    });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'Note');
    expect(await screen.findByText('No activities match these filters')).toBeVisible();
  });

  it('shows a record’s timeline with the same filters, and pages it', async () => {
    const { user, requests } = renderApp({
      // A date that is not one yet is pointed out and not sent.
      path: `${path}&from=2026-13-01`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /members': () => json(MEMBERS),
        'GET /activities': (request) =>
          request.query.get('offset') === '0'
            ? json({ items: TIMELINE, total: TIMELINE_PAGE_SIZE + 1 })
            : json({ items: [], total: 0 }),
      },
    });
    const timeline = await screen.findByRole('region', { name: 'Apex Builders' });
    expect(screen.getByText('Enter a date')).toBeVisible();
    expect(lastQuery(requests)).toBe(`recordType=party&recordId=${PARTY.id}&limit=50&offset=0`);
    expect(subjects(timeline)).toEqual([
      'Call about the quote',
      'Showed the shade card',
      'Old reminder',
    ]);
    expect(within(timeline).getByText('Visit · Done · 25 Sept 2026, 11:30 am')).toBeVisible();
    expect(within(timeline).getByText('By Ravi Teja · Assigned to Anil Kumar')).toBeVisible();
    expect(within(timeline).getByText('Liked Apex Ultima')).toBeVisible();
    expect(within(timeline).getByText('Outcome: Wants a quote')).toBeVisible();
    // On a record's timeline the record is the page's own; no record filter or links per item.
    expect(screen.queryByRole('combobox', { name: 'Record' })).toBeNull();
    expect(screen.getByText('Customer or party')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the record' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}`,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Person' }), 'Me');
    await waitFor(() => {
      expect(lastQuery(requests)).toBe(
        `recordType=party&recordId=${PARTY.id}&person=me&limit=50&offset=0`,
      );
    });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('offset')).toBe('50');
    });
    expect(await screen.findByText('No activities match these filters')).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'All activities' }));
    expect(await screen.findByRole('combobox', { name: 'Record' })).toBeVisible();
    expect(location()).toBe('/activities');
  });

  it('says when nothing is logged, and shows failures', async () => {
    const view = renderApp({
      path,
      routes: {
        'GET /auth/me': () => json(profile(['parties:read'])),
        'GET /activities': () => json({ items: [], total: 0 }),
      },
    });
    expect(await screen.findByText('Nothing has been logged on this record yet')).toBeVisible();
    view.unmount();

    const all = renderApp({
      path: '/activities',
      routes: {
        'GET /auth/me': () => json(profile(['leads:read'])),
        'GET /activities': () => json({ items: [], total: 0 }),
      },
    });
    expect(await screen.findByText('Nothing has been logged yet')).toBeVisible();
    // Only the kinds of record the role can see, and no team list without members:read.
    expect(
      within(screen.getByRole('combobox', { name: 'Record' }))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All records', 'Lead', 'Opportunity']);
    expect(
      within(screen.getByRole('combobox', { name: 'Person' }))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Everyone', 'Me']);
    all.unmount();

    renderApp({
      path: '/activities?recordType=lead&recordId=lead-1',
      routes: {
        'GET /auth/me': () => json(profile(['leads:read'])),
        'GET /activities': () => json({ message: 'Lead not found' }, 404),
      },
    });
    expect(await screen.findByText('Could not load the timeline')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the record' })).toHaveAttribute(
      'href',
      '/leads/lead-1',
    );
  });

  it('is closed to roles that see none of the records activities are on', async () => {
    renderApp({ path, routes: { 'GET /auth/me': () => json(profile(['catalog:read'])) } });
    expect(await screen.findByText('No access')).toBeVisible();
  });
});
