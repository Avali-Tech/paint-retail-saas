import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import { CANCELLED_NOTE, DONE_VISIT, FOLLOW_UP, RAVI } from '../test-support/follow-up-fixtures.js';
import { PARTY } from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { TIMELINE_PAGE_SIZE } from './ActivitiesPage.js';

const TIMELINE = [FOLLOW_UP, DONE_VISIT, CANCELLED_NOTE];
const path = `/activities?recordType=party&recordId=${PARTY.id}`;
const location = () => screen.getByTestId('location').textContent;
const subjects = () =>
  within(screen.getByRole('region', { name: 'Apex Builders' }))
    .queryAllByRole('listitem')
    .map((item) => item.querySelector('.record-list__title')?.firstChild?.textContent?.trim());

describe('ActivitiesPage', { timeout: 30_000 }, () => {
  it('starts by choosing a customer, then opens their timeline', async () => {
    const { user } = renderApp({
      path: '/activities',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /parties': () => json({ items: [PARTY], total: 1 }),
        'GET /activities': () => json({ items: TIMELINE, total: 3 }),
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Activity timeline', level: 1 }),
    ).toBeVisible();
    expect(
      screen.getByText(
        'Leads, opportunities and projects open their timeline from their own pages.',
      ),
    ).toBeVisible();
    await user.type(
      screen.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }),
      'apex',
    );
    await user.click(await screen.findByRole('button', { name: 'Choose Apex Builders' }));
    await waitFor(() => {
      expect(location()).toBe(path);
    });
    expect(await screen.findByRole('region', { name: 'Apex Builders' })).toBeVisible();
    expect(screen.getByText('Customer or party')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the record' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}`,
    );
    await user.click(screen.getByRole('link', { name: 'Choose another record' }));
    expect(await screen.findByRole('region', { name: 'Choose a customer or party' })).toBeVisible();
  });

  it('filters a timeline by type, person and India-time dates', async () => {
    const { user, requests } = renderApp({
      path,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /activities': () => json({ items: TIMELINE, total: 3 }),
      },
    });
    const timeline = await screen.findByRole('region', { name: 'Apex Builders' });
    expect(requests.at(-1)?.query.toString()).toBe(
      `recordType=party&recordId=${PARTY.id}&limit=200&offset=0`,
    );
    expect(subjects()).toEqual(['Call about the quote', 'Showed the shade card', 'Old reminder']);
    expect(within(timeline).getByText('Visit · Done · 25 Sept 2026, 11:30 am')).toBeVisible();
    expect(within(timeline).getByText('By Ravi Teja · Assigned to Anil Kumar')).toBeVisible();
    expect(within(timeline).getByText('Liked Apex Ultima')).toBeVisible();
    expect(within(timeline).getByText('Outcome: Wants a quote')).toBeVisible();
    expect(within(timeline).getByText('Showing 3 of 3 on this page')).toBeVisible();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'Visit');
    await waitFor(() => {
      expect(subjects()).toEqual(['Showed the shade card']);
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'All types');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Person' }), RAVI.name);
    await waitFor(() => {
      expect(subjects()).toEqual(['Showed the shade card']);
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Person' }), 'Everyone');

    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: '2026-09-21' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-09-30' } });
    await waitFor(() => {
      expect(subjects()).toEqual(['Showed the shade card', 'Old reminder']);
    });
    expect(location()).toBe(`${path}&from=2026-09-21&to=2026-09-30`);

    // A backwards range is pointed out, and only the valid "from" date filters.
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-09-01' } });
    expect(await screen.findByText('The “to” date cannot be before the “from” date')).toBeVisible();
    expect(subjects()).toHaveLength(3);

    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: '2026-10-06' } });
    expect(await screen.findByText('No activities match these filters')).toBeVisible();
  });

  it('pages long timelines and says when nothing is logged', async () => {
    const { user, requests } = renderApp({
      // A date that is not one yet is pointed out and does not filter.
      path: `${path}&from=2026-13-01`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /activities': (request) =>
          request.query.get('offset') === '0'
            ? json({ items: [FOLLOW_UP], total: TIMELINE_PAGE_SIZE + 1 })
            : json({ items: [], total: 0 }),
      },
    });
    await screen.findByRole('region', { name: 'Apex Builders' });
    expect(screen.getByText('Enter a date')).toBeVisible();
    expect(subjects()).toEqual(['Call about the quote']);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Nothing has been logged on this record yet')).toBeVisible();
    expect(requests.at(-1)?.query.get('offset')).toBe('200');
  });

  it('explains where timelines open for roles without customers, and shows failures', async () => {
    const view = renderApp({
      path: '/activities?recordType=invoice&recordId=x',
      routes: { 'GET /auth/me': () => json(profile(['leads:read'])) },
    });
    expect(
      await screen.findByText('Open a timeline from a customer, lead, opportunity or project.'),
    ).toBeVisible();
    view.unmount();

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
