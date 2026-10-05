import { SYSTEM_ROLES } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import { CONTRACT, DRAFT } from '../test-support/contract-fixtures.js';
import { PARTY } from '../test-support/party-fixtures.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import { CONTRACT_PAGE_SIZE } from './ContractsPage.js';

const INVENTORY = profile(
  SYSTEM_ROLES.find((role) => role.key === 'inventory_manager')?.permissions,
  { role: { key: 'inventory_manager', name: 'Inventory Manager' } },
);
const location = () => screen.getByTestId('location').textContent;

describe('ContractsPage', { timeout: 30_000 }, () => {
  it('lists contracts and filters by type, status, renewals and party', async () => {
    const { user, requests } = renderApp({
      path: '/contracts',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /contracts': () => json({ items: [CONTRACT, DRAFT], total: 2 }),
        'GET /parties': () => json({ items: [PARTY], total: 1 }),
        'GET /parties/:id': () => json(PARTY),
      },
    });
    const table = await screen.findByRole('table', { name: 'Contracts' });
    expect(requests.at(-1)?.query.toString()).toBe('limit=50&offset=0');
    const [, first, second] = within(table).getAllByRole('row');
    expect(within(found(first)).getByRole('link', { name: 'CT-000001' })).toHaveAttribute(
      'href',
      `/contracts/${CONTRACT.id}`,
    );
    expect(first).toHaveTextContent(
      'CT-000001Annual painting contractApex BuildersContractor agreementActiveRenewal due1 Nov 2025 – 31 Oct 2026₹10,00,000.00Anil Kumar',
    );
    expect(second).toHaveTextContent('Supplier agreementDraft');
    expect(second).toHaveTextContent('—');
    expect(screen.getByRole('link', { name: '+ Contract' })).toHaveAttribute(
      'href',
      '/contracts/new',
    );

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Type' }),
      'Contractor agreement',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Active');
    const days = screen.getByRole('textbox', { name: 'Renewal due in (days)' });
    await user.type(days, 'month');
    expect(await screen.findByText('Enter 0 to 366 days')).toBeVisible();
    await user.clear(days);
    await user.type(days, '30');
    await user.type(
      screen.getByRole('searchbox', { name: 'Search by number, title or party' }),
      'annual',
    );
    await waitFor(() => {
      expect(requests.at(-1)?.query.toString()).toBe(
        'q=annual&type=contractor_agreement&status=active&renewalDue=30&limit=50&offset=0',
      );
    });

    await user.click(screen.getByRole('button', { name: 'Choose a party' }));
    const dialog = screen.getByRole('dialog', { name: 'Choose a party' });
    await user.type(within(dialog).getByRole('searchbox'), 'apex');
    await user.click(await within(dialog).findByRole('button', { name: 'Choose Apex Builders' }));
    expect(await screen.findByText('Apex Builders', { selector: 'span' })).toBeVisible();
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('partyId')).toBe(PARTY.id);
    });
    // A new contract starts with the party chosen.
    expect(screen.getByRole('link', { name: '+ Contract' })).toHaveAttribute(
      'href',
      `/contracts/new?partyId=${PARTY.id}`,
    );
    await user.click(screen.getByRole('button', { name: 'Show everyone' }));
    await waitFor(() => {
      expect(location()).not.toContain('partyId');
    });
  });

  it('explains an empty list, a filtered one, paging and failures', async () => {
    let answer: 'page' | 'empty' | 'down' = 'empty';
    const { user } = renderApp({
      path: '/contracts',
      routes: {
        'GET /auth/me': () => json(INVENTORY),
        'GET /contracts': (request) => {
          if (answer === 'down') return json({ message: 'Database down' }, 503);
          if (answer === 'page' && request.query.get('offset') === '0') {
            return json({ items: [CONTRACT], total: CONTRACT_PAGE_SIZE + 1 });
          }
          return json({ items: [], total: 0 });
        },
      },
    });
    expect(await screen.findByText('No contracts yet')).toBeVisible();
    // Inventory managers read contracts but do not create them.
    expect(screen.queryByRole('link', { name: '+ Contract' })).toBeNull();
    answer = 'page';
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Draft');
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    expect(await screen.findByText('No contracts match these filters')).toBeVisible();
    answer = 'down';
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'Other agreement');
    expect(await screen.findByText('Could not load contracts')).toBeVisible();
  });

  it('shows a chosen party by name while it loads', async () => {
    renderApp({
      path: `/contracts?partyId=${PARTY.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /contracts': () => json({ items: [], total: 0 }),
        'GET /parties/:id': () => new Promise(() => undefined),
      },
    });
    expect(await screen.findByText('No contracts match these filters')).toBeVisible();
    expect(screen.getAllByText('Loading…').length).toBeGreaterThan(0);
  });
});
