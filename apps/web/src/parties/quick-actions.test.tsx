import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CASHIER, OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { BARE_PARTY, CREDIT_REQUEST, PARTY, loyaltyView } from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';

const location = () => screen.getByTestId('location').textContent;

/** Parties whose name contains the search, like GET /parties?q=. */
const searchParties: FakeHandler = (request) => {
  const q = (request.query.get('q') ?? '').toLowerCase();
  const items = [PARTY, BARE_PARTY].filter((party) => party.displayName.toLowerCase().includes(q));
  return json({ items, total: items.length });
};

function renderQuickAction(path: string, routes: Record<string, FakeHandler>, member = OWNER) {
  return renderApp({
    path,
    routes: { 'GET /auth/me': () => json(member), 'GET /parties': searchParties, ...routes },
  });
}

describe('+ Credit request (/credit-requests/new)', { timeout: 30_000 }, () => {
  it('finds the customer, checks the request and opens it once sent', async () => {
    const bodies: unknown[] = [];
    const { user } = renderQuickAction('/credit-requests/new', {
      'POST /credit-requests': (request) => {
        bodies.push(request.body);
        return bodies.length === 1
          ? json({ message: 'CR-000009 is already waiting for approval' }, 409)
          : json(CREDIT_REQUEST, 201);
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Request a credit limit', level: 1 }),
    ).toBeVisible();
    expect(screen.getByText('Type a name, mobile number or GSTIN')).toBeVisible();
    const search = screen.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' });
    await user.type(search, 'nobody');
    expect(await screen.findByText('No one found for “nobody”')).toBeVisible();
    await user.clear(search);
    await user.type(search, 'walk');
    await user.click(await screen.findByRole('button', { name: 'Choose Walk-in Ramesh' }));
    expect(screen.getByRole('heading', { name: 'Walk-in Ramesh' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Choose someone else' }));
    await user.type(
      screen.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }),
      'apex',
    );
    const apex = await screen.findByRole('button', { name: 'Choose Apex Builders' });
    expect(screen.getByText('+919876543210 · Hyderabad')).toBeVisible();
    await user.click(apex);

    const send = screen.getByRole('button', { name: 'Send for approval' });
    await user.click(send);
    expect(
      screen.getByText('Enter an amount in rupees, above zero and up to ₹10 crore'),
    ).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Limit (₹)' }), '100000');
    await user.click(send);
    expect(screen.getByText('Enter 0 to 365 days')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Days to pay' }), '45');
    await user.click(send);
    expect(await screen.findByText('CR-000009 is already waiting for approval')).toBeVisible();
    await user.type(
      screen.getByRole('textbox', { name: 'Why this customer should get it' }),
      'Big order',
    );
    await user.click(send);
    expect(await screen.findByText('Credit request sent for approval')).toBeVisible();
    await waitFor(() => {
      expect(location()).toBe(`/credit-requests/${CREDIT_REQUEST.id}`);
    });
    expect(bodies).toEqual([
      { partyId: PARTY.id, limitPaise: 1_00_000_00, creditDays: 45 },
      { partyId: PARTY.id, limitPaise: 1_00_000_00, creditDays: 45, note: 'Big order' },
    ]);
  });

  it('tells members without credit:manage they have no access', async () => {
    renderQuickAction('/credit-requests/new', {}, CASHIER);
    expect(await screen.findByText('No access')).toBeInTheDocument();
  });
});

describe('+ Loyalty (/loyalty/new)', { timeout: 30_000 }, () => {
  it('finds the painter and enrols them with a salesperson', async () => {
    const bodies: unknown[] = [];
    const { user } = renderQuickAction('/loyalty/new', {
      'GET /members': () =>
        json([
          { id: 'm1', user: { fullName: 'Sunita Rao' }, role: { name: 'Sales' }, isActive: true },
        ]),
      'POST /parties/:id/loyalty': (request) => {
        bodies.push(request.body);
        return bodies.length === 1
          ? json({ message: 'This party already has a loyalty account' }, 409)
          : json(loyaltyView(), 201);
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Enrol in the loyalty programme', level: 1 }),
    ).toBeVisible();
    await user.type(
      screen.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }),
      'walk',
    );
    await user.click(await screen.findByRole('button', { name: 'Choose Walk-in Ramesh' }));
    await user.click(screen.getByRole('button', { name: 'Choose someone else' }));
    await user.type(
      screen.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }),
      'apex',
    );
    await user.click(await screen.findByRole('button', { name: 'Choose Apex Builders' }));
    await user.click(screen.getByRole('button', { name: 'Enrol' }));
    expect(await screen.findByText('This party already has a loyalty account')).toBeVisible();
    const salesperson = screen.getByRole('combobox', { name: 'Looked after by' });
    await within(salesperson).findByRole('option', { name: 'Sunita Rao · Sales' });
    await user.selectOptions(salesperson, 'Sunita Rao · Sales');
    await user.click(screen.getByRole('button', { name: 'Enrol' }));
    expect(await screen.findByText('Enrolled in the loyalty programme')).toBeVisible();
    await waitFor(() => {
      expect(location()).toBe(`/parties/${PARTY.id}`);
    });
    expect(bodies).toEqual([{}, { assignedMemberId: 'm1' }]);
  });

  it('enrols without a salesperson when the member cannot see the team', async () => {
    let body: unknown;
    const { user } = renderQuickAction(
      '/loyalty/new',
      {
        'POST /parties/:id/loyalty': (request) => {
          body = request.body;
          return json(loyaltyView(), 201);
        },
      },
      profile(['parties:read', 'loyalty:read', 'loyalty:manage']),
    );
    await user.type(
      await screen.findByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }),
      'apex',
    );
    await user.click(await screen.findByRole('button', { name: 'Choose Apex Builders' }));
    expect(screen.queryByRole('combobox', { name: 'Looked after by' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Enrol' }));
    expect(await screen.findByText('Enrolled in the loyalty programme')).toBeVisible();
    expect(body).toEqual({});
  });

  it('tells members without loyalty:manage they have no access', async () => {
    renderQuickAction('/loyalty/new', {}, CASHIER);
    expect(await screen.findByText('No access')).toBeInTheDocument();
  });
});
