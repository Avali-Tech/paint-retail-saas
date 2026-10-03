import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CASHIER, OWNER, json } from '../test-support/fake-api.js';
import { BARE_PARTY, PARTY } from '../test-support/party-fixtures.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import { PAGE_SIZE } from './PartiesPage.js';

const location = () => screen.getByTestId('location').textContent;

describe('PartiesPage', { timeout: 30_000 }, () => {
  it('lists parties with their roles and details, and searches and filters through the address', async () => {
    const { user, requests } = renderApp({
      path: '/parties',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /parties': () => json({ items: [PARTY, BARE_PARTY], total: 2 }),
      },
    });
    const table = await screen.findByRole('table', { name: 'Customers' });
    const rows = within(table).getAllByRole('row');
    expect(within(found(rows[1])).getByRole('link', { name: 'Apex Builders' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}`,
    );
    expect(rows[1]).toHaveTextContent('CustomerContractor+919876543210Hyderabad36AABCU9603R1ZO');
    expect(rows[2]).toHaveTextContent('Walk-in Ramesh InactivePainter———');
    expect(screen.getByRole('link', { name: '+ Customer' })).toHaveAttribute(
      'href',
      '/parties/new',
    );
    // A single page needs no paging.
    expect(screen.queryByRole('navigation', { name: 'Customer pages' })).toBeNull();

    await user.type(
      screen.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }),
      'apex',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'Sub-dealer');
    await user.click(screen.getByRole('checkbox', { name: 'Show inactive' }));
    await waitFor(() => {
      expect(location()).toBe('/parties?q=apex&role=sub_dealer&inactive=1');
    });
    await waitFor(() => {
      expect(requests.at(-1)?.query.toString()).toBe(
        'q=apex&role=sub_dealer&includeInactive=true&limit=50&offset=0',
      );
    });
    await user.click(screen.getByRole('checkbox', { name: 'Show inactive' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'All roles');
    await user.clear(screen.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }));
    await waitFor(() => {
      expect(location()).toBe('/parties');
    });
  });

  it('pages through long lists', async () => {
    const { user, requests } = renderApp({
      path: '/parties',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /parties': () => json({ items: [PARTY], total: PAGE_SIZE + 5 }),
      },
    });
    const pages = await screen.findByRole('navigation', { name: 'Customer pages' });
    expect(pages).toHaveTextContent('1–50 of 55');
    await user.click(within(pages).getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(location()).toBe('/parties?offset=50');
    });
    expect(await screen.findByText('51–55 of 55')).toBeInTheDocument();
    expect(requests.at(-1)?.query.get('offset')).toBe('50');
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => {
      expect(location()).toBe('/parties');
    });
  });

  it('explains an empty list, with or without filters, and hides adding from read-only roles', async () => {
    renderApp({
      path: '/parties',
      routes: {
        'GET /auth/me': () => json(CASHIER),
        'GET /parties': () => json({ items: [], total: 0 }),
      },
    });
    expect(await screen.findByText('No customers yet')).toBeInTheDocument();
    expect(
      screen.getByText('Add the people and businesses you sell to and buy from.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '+ Customer' })).toBeNull();
  });

  it('says when filters match no one', async () => {
    const { requests } = renderApp({
      path: '/parties?role=architect',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /parties': () => json({ items: [], total: 0 }),
      },
    });
    expect(await screen.findByText('No one matches these filters')).toBeInTheDocument();
    expect(requests.find((request) => request.path === '/parties')?.query.get('role')).toBe(
      'architect',
    );
  });

  it('ignores a role in the address that does not exist', async () => {
    const { requests } = renderApp({
      path: '/parties?role=wizard',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /parties': () => json({ items: [PARTY], total: 1 }),
      },
    });
    expect(await screen.findByRole('link', { name: 'Apex Builders' })).toBeInTheDocument();
    expect(requests.find((request) => request.path === '/parties')?.query.has('role')).toBe(false);
  });

  it('shows a failure with a way to try again', async () => {
    let calls = 0;
    const { user } = renderApp({
      path: '/parties',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /parties': () => {
          calls += 1;
          return calls === 1
            ? json({ message: 'Database down' }, 503)
            : json({ items: [PARTY], total: 1 });
        },
      },
    });
    expect(await screen.findByText('Could not load customers')).toBeInTheDocument();
    expect(screen.getByText('Database down')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Apex Builders' })).toBeInTheDocument();
  });
});
