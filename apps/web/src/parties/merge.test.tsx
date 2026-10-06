import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Party } from '../api/parties.js';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import { OVERVIEW, PARTY, STORES, loyaltyView } from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';

const KEEP: Party = {
  ...PARTY,
  id: '22222222-2222-4222-8222-222222222222',
  displayName: 'Apex Builders Pvt Ltd',
  phone: '+919800000002',
};
const location = () => screen.getByTestId('location').textContent;
const routes = (extra = {}) => ({
  'GET /parties/:id/overview': () => json(OVERVIEW),
  'GET /parties/:id/loyalty': () => json(loyaltyView()),
  'GET /documents': () => json([]),
  'GET /stores': () => json(STORES),
  ...extra,
});

describe('merging a duplicate from the customer 360', { timeout: 30_000 }, () => {
  it('chooses the record to keep, explains the rules, shows refusals and opens the survivor', async () => {
    let refuse = true;
    const { user, requests } = renderApp({
      path: `/parties/${PARTY.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        ...routes(),
        'GET /parties': () => json({ items: [PARTY, KEEP], total: 2 }),
        'POST /parties/:id/merge': () => {
          if (refuse) {
            refuse = false;
            return json(
              { message: 'Both parties have a credit request waiting; decide one first' },
              409,
            );
          }
          return json({
            party: KEEP,
            moved: { 'leads.party_id': 3, 'activities.record_id': 2, 'contracts.party_id': 0 },
          });
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Merge into…' }));
    const dialog = screen.getByRole('dialog', { name: 'Merge Apex Builders into another record' });
    const rules = within(dialog).getByRole('region', { name: 'What happens' });
    expect(within(rules).getAllByRole('listitem')).toHaveLength(5);
    expect(
      within(rules).getByText(/^Credit: refused when both have a credit request/),
    ).toBeVisible();
    expect(within(rules).getByText('This cannot be undone.')).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));
    expect(await within(dialog).findByText('First choose the record to keep')).toBeVisible();

    await user.type(within(dialog).getByRole('searchbox'), 'apex');
    // Picking the same record is pointed out.
    await user.click(await within(dialog).findByRole('button', { name: 'Choose Apex Builders' }));
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));
    expect(await within(dialog).findByText('Choose a different record to keep')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Choose another' }));
    await user.type(within(dialog).getByRole('searchbox'), 'apex');
    await user.click(
      await within(dialog).findByRole('button', { name: 'Choose Apex Builders Pvt Ltd' }),
    );
    expect(
      within(dialog).getByText('Keep Apex Builders Pvt Ltd; merge Apex Builders into it'),
    ).toBeVisible();

    // A refusal (credit or loyalty rules) comes back from the API and is shown.
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));
    expect(
      await within(dialog).findByText(
        'Both parties have a credit request waiting; decide one first',
      ),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));
    expect(await screen.findByText('Merged into Apex Builders Pvt Ltd')).toBeVisible();
    expect(screen.getByText('5 records moved')).toBeVisible();
    await waitFor(() => {
      expect(location()).toBe(`/parties/${KEEP.id}`);
    });
    expect(requests.find((request) => request.method === 'POST')?.body).toEqual({
      intoPartyId: KEEP.id,
    });
  });

  it('is only for members who see every store, and not for a record already merged', async () => {
    const branch = profile(['parties:read', 'parties:manage'], { allStores: false });
    const view = renderApp({
      path: `/parties/${PARTY.id}`,
      routes: { 'GET /auth/me': () => json(branch), ...routes() },
    });
    expect(await screen.findByRole('link', { name: 'Edit' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Merge into…' })).toBeNull();
    view.unmount();

    renderApp({
      path: `/parties/${PARTY.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        ...routes({
          'GET /parties/:id/overview': () =>
            json({ ...OVERVIEW, party: { ...PARTY, isActive: false, mergedIntoId: KEEP.id } }),
        }),
      },
    });
    expect(await screen.findByText('This record was merged into another one.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Merge into…' })).toBeNull();
  });
});
