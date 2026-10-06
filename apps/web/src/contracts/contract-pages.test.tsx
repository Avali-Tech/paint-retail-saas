import { SYSTEM_ROLES } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Member } from '../api/team.js';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import { CONTRACT, DRAFT, ENDED } from '../test-support/contract-fixtures.js';
import { PARTY } from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';

const roleProfile = (key: string) =>
  profile(SYSTEM_ROLES.find((role) => role.key === key)?.permissions, {
    role: { key, name: key },
  });
const CRM = roleProfile('crm_executive');
const INVENTORY = roleProfile('inventory_manager');
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
  {
    id: 'store-old',
    code: 'OLD',
    name: 'Closed',
    type: 'store',
    city: null,
    state: null,
    gstin: null,
    isActive: false,
  },
];
const member = (id: string, userId: string, fullName: string, isActive = true): Member => ({
  id,
  user: { id: userId, fullName, phone: null, email: null },
  role: { id: 'r1', key: 'crm_executive', name: 'CRM Executive' },
  allStores: true,
  storeIds: [],
  isActive,
  twoFactorEnabled: false,
});
const MEMBERS = [
  member('member-1', 'user-1', 'Anil Kumar'),
  member('member-2', 'user-2', 'Priya Sharma'),
  member('member-3', 'user-3', 'Gone Person', false),
];
const location = () => screen.getByTestId('location').textContent;
const facts = () => screen.getByRole('region', { name: 'Details' });

describe('ContractDetailPage', { timeout: 30_000 }, () => {
  it('shows an active contract with its terms and documents, and renews it', async () => {
    const renewals: unknown[] = [];
    const { user } = renderApp({
      path: `/contracts/${CONTRACT.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /contracts/:id': (request) =>
          json(
            request.path.endsWith('renewed')
              ? { ...CONTRACT, id: 'renewed', number: 'CT-000004' }
              : CONTRACT,
          ),
        'GET /documents': () => json([]),
        'POST /contracts/:id/renew': (request) => {
          renewals.push(request.body);
          return json({ ...CONTRACT, id: 'renewed', number: 'CT-000004' }, 201);
        },
      },
    });
    expect(
      await screen.findByRole('heading', {
        name: 'CT-000001 · Annual painting contract',
        level: 1,
      }),
    ).toBeVisible();
    expect(screen.getByText('Renewal due')).toBeVisible();
    expect(within(facts()).getByRole('link', { name: 'Apex Builders' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}`,
    );
    expect(within(facts()).getByText('HYD · Hyderabad')).toBeVisible();
    expect(within(facts()).getByText('31 Oct 2026 · 25 days left')).toBeVisible();
    expect(within(facts()).getByText('₹10,00,000.00')).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: 'Terms' })).getByText(
        /Paint supplied at 12% below MRP/,
      ),
    ).toHaveClass('prewrap');
    expect(await screen.findByRole('region', { name: 'Documents' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      `/contracts/${CONTRACT.id}/edit`,
    );
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Renew' }));
    const dialog = screen.getByRole('dialog', { name: 'Renew CT-000001' });
    expect(
      within(dialog).getByText('Leave empty to start the day after this one ends (1 Nov 2026)'),
    ).toBeVisible();
    const value = within(dialog).getByRole('textbox', { name: 'Value (₹)' });
    expect(value).toHaveValue('1000000.00');
    const send = () => user.click(within(dialog).getByRole('button', { name: 'Renew' }));
    await user.clear(value);
    await user.type(value, 'lots');
    await send();
    expect(await within(dialog).findByText('Enter a date')).toBeVisible();
    expect(within(dialog).getByText(/Enter an amount in rupees/)).toBeVisible();
    await user.type(within(dialog).getByLabelText(/^End date/), '2026-10-31');
    await send();
    expect(
      await within(dialog).findByText('The end date cannot be before the start date'),
    ).toBeVisible();
    await user.clear(within(dialog).getByLabelText(/^End date/));
    await user.type(within(dialog).getByLabelText(/^End date/), '2027-10-31');
    await user.clear(value);
    await user.type(value, '12,00,000');
    await send();
    expect(await screen.findByText('Renewed as CT-000004')).toBeVisible();
    await waitFor(() => {
      expect(location()).toBe('/contracts/renewed');
    });
    expect(renewals).toEqual([{ endDate: '2027-10-31', valuePaise: 12_00_000_00 }]);
  });

  it('renews from a chosen start without a value, and terminates with a reason', async () => {
    const calls: [string, unknown][] = [];
    const { user } = renderApp({
      path: `/contracts/${CONTRACT.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /contracts/:id': () =>
          json({ ...CONTRACT, status: 'expired', daysToEnd: -3, renewalDue: false }),
        'GET /documents': () => json([]),
        'POST /contracts/:id/renew': (request) => {
          calls.push(['renew', request.body]);
          return json({ message: 'This contract is terminated' }, 409);
        },
        'POST /contracts/:id/terminate': (request) => {
          calls.push(['terminate', request.body]);
          return json({ ...CONTRACT, status: 'terminated' });
        },
      },
    });
    expect(await screen.findByText('31 Oct 2026 · Ended 3 days ago')).toBeVisible();
    expect(screen.getByText('Expired')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Renew' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Start date/), '2026-11-15');
    await user.type(within(dialog).getByLabelText(/^End date/), '2027-11-14');
    await user.clear(within(dialog).getByRole('textbox', { name: 'Value (₹)' }));
    await user.click(within(dialog).getByRole('button', { name: 'Renew' }));
    expect(await within(dialog).findByText('This contract is terminated')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Terminate' }));
    const reason = screen.getByRole('dialog', { name: 'Terminate CT-000001?' });
    await user.type(
      within(reason).getByRole('textbox', { name: 'Reason' }),
      'Contractor stopped work',
    );
    await user.click(within(reason).getByRole('button', { name: 'Terminate' }));
    expect(await screen.findByText('Contract terminated')).toBeVisible();
    expect(calls).toEqual([
      ['renew', { startDate: '2026-11-15', endDate: '2027-11-14', valuePaise: null }],
      ['terminate', { reason: 'Contractor stopped work' }],
    ]);
  });

  it('activates a draft, showing why the server refused', async () => {
    let refuse = true;
    const { user } = renderApp({
      path: `/contracts/${DRAFT.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /contracts/:id': () => json(DRAFT),
        'GET /documents': () => json([]),
        'POST /contracts/:id/activate': () => {
          if (refuse) {
            refuse = false;
            return json({ message: 'This contract has already ended' }, 409);
          }
          return json({ ...DRAFT, status: 'active' });
        },
      },
    });
    await screen.findByRole('heading', { name: 'CT-000002 · Berger supply terms', level: 1 });
    expect(within(facts()).getByText('Whole business')).toBeVisible();
    expect(
      within(facts()).getByRole('link', { name: 'PJ-000003 · Kondapur tower' }),
    ).toHaveAttribute('href', '/projects/project-1');
    expect(within(facts()).getByText('31 Oct 2026 · Ends today')).toBeVisible();
    expect(within(facts()).getByText('—')).toBeVisible();
    expect(screen.getByText('No terms written down')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Renew' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    const dialog = screen.getByRole('dialog', { name: 'Put CT-000002 in force?' });
    await user.click(within(dialog).getByRole('button', { name: 'Activate' }));
    expect(await within(dialog).findByText('This contract has already ended')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText('Contract activated')).toBeVisible();
  });

  it('shows an ended contract and its renewals without actions', async () => {
    renderApp({
      path: `/contracts/${ENDED.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /contracts/:id': () => json(ENDED),
        'GET /documents': () => json([]),
      },
    });
    await screen.findByRole('heading', { name: 'CT-000003 · Annual painting contract', level: 1 });
    expect(within(facts()).getByText('Contractor stopped work')).toBeVisible();
    expect(within(facts()).getByText('31 Oct 2026')).toBeVisible();
    expect(within(facts()).getByRole('link', { name: 'CT-000001' })).toHaveAttribute(
      'href',
      `/contracts/${CONTRACT.id}`,
    );
    expect(within(facts()).getByRole('link', { name: 'CT-000002' })).toHaveAttribute(
      'href',
      `/contracts/${DRAFT.id}`,
    );
    const terms = screen.getByRole('region', { name: 'Terms' });
    expect(within(terms).getByText('30 days')).toBeVisible();
    expect(within(terms).getByText('Call before visiting')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Terminate' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
  });

  it('lets read-only roles look, and says when a contract cannot be seen', async () => {
    const view = renderApp({
      path: `/contracts/${CONTRACT.id}`,
      routes: {
        'GET /auth/me': () => json(INVENTORY),
        'GET /contracts/:id': () => json(CONTRACT),
        'GET /documents': () => json([]),
      },
    });
    await screen.findByRole('heading', { name: 'CT-000001 · Annual painting contract', level: 1 });
    expect(screen.queryByRole('button', { name: 'Renew' })).toBeNull();
    view.unmount();
    renderApp({
      path: `/contracts/${CONTRACT.id}`,
      routes: {
        'GET /auth/me': () => json(INVENTORY),
        'GET /contracts/:id': () => json({ message: 'Contract not found' }, 404),
      },
    });
    expect(await screen.findByText('Could not load this contract')).toBeVisible();
  });
});

describe('contract form', { timeout: 30_000 }, () => {
  it('creates a draft for a chosen party, checking the form first', async () => {
    const created: unknown[] = [];
    let refuse: 'field' | 'other' | null = 'field';
    const { user } = renderApp({
      path: '/contracts/new',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /parties': () => json({ items: [PARTY], total: 1 }),
        'GET /stores': () => json(STORES),
        'GET /members': () => json(MEMBERS),
        'GET /contracts/:id': () => json(CONTRACT),
        'GET /documents': () => json([]),
        'POST /contracts': (request) => {
          created.push(request.body);
          if (refuse === 'field') {
            refuse = 'other';
            return json(
              {
                message: 'Invalid request',
                issues: [{ path: 'title', message: 'Too long for the API' }],
              },
              400,
            );
          }
          if (refuse === 'other') {
            refuse = null;
            return json({ message: 'Unknown project' }, 400);
          }
          return json(CONTRACT, 201);
        },
      },
    });
    await user.type(
      await screen.findByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }),
      'apex',
    );
    await user.click(await screen.findByRole('button', { name: 'Choose Apex Builders' }));
    expect(await screen.findByRole('region', { name: 'Apex Builders' })).toBeVisible();
    const store = screen.getByRole('combobox', { name: 'Store' });
    expect(within(store).queryByRole('option', { name: 'OLD · Closed' })).toBeNull();
    const assignee = screen.getByRole('combobox', { name: 'Looked after by' });
    expect(
      within(assignee)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Me', 'Priya Sharma']);

    const save = () => user.click(screen.getByRole('button', { name: 'Save as draft' }));
    await save();
    expect(await screen.findByText('Enter a title')).toBeVisible();
    expect(screen.getAllByText('Enter a date')).toHaveLength(2);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'Dealer agreement');
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Dealer terms 2026');
    await user.selectOptions(store, 'HYD · Hyderabad');
    await user.type(screen.getByLabelText(/^Start date/), '2026-11-01');
    await user.type(screen.getByLabelText(/^End date/), '2026-10-01');
    await user.type(screen.getByRole('textbox', { name: 'Value (₹)' }), '2,50,000');
    await user.selectOptions(assignee, 'Priya Sharma');
    await user.type(screen.getByRole('textbox', { name: 'Terms' }), '12% below MRP');
    await save();
    expect(await screen.findByText('The end date cannot be before the start date')).toBeVisible();
    await user.clear(screen.getByLabelText(/^End date/));
    await user.type(screen.getByLabelText(/^End date/), '2027-10-31');
    await save();
    expect(await screen.findByText('Too long for the API')).toBeVisible();
    await save();
    expect(await screen.findByText('Unknown project')).toBeVisible();
    await save();
    expect(await screen.findByText('Contract saved as a draft')).toBeVisible();
    await waitFor(() => {
      expect(location()).toBe(`/contracts/${CONTRACT.id}`);
    });
    expect(created.at(-1)).toEqual({
      type: 'dealer_agreement',
      title: 'Dealer terms 2026',
      partyId: PARTY.id,
      storeId: 'store-hyd',
      startDate: '2026-11-01',
      endDate: '2027-10-31',
      valuePaise: 2_50_000_00,
      terms: '12% below MRP',
      assignedMemberId: 'member-2',
    });
  });

  it('starts with the party given in the address, and can change it', async () => {
    const { user } = renderApp({
      path: `/contracts/new?partyId=${PARTY.id}`,
      routes: {
        'GET /auth/me': () => json(CRM),
        'GET /parties/:id': () => json(PARTY),
        'GET /stores': () => json(STORES),
      },
    });
    expect(await screen.findByRole('region', { name: 'Apex Builders' })).toBeVisible();
    // Without the team list there is no one else to choose.
    expect(screen.queryByRole('combobox', { name: 'Looked after by' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Choose someone else' }));
    expect(await screen.findByRole('region', { name: 'Who the contract is with' })).toBeVisible();
  });

  it('says when the given party cannot be loaded', async () => {
    renderApp({
      path: '/contracts/new?partyId=missing',
      routes: {
        'GET /auth/me': () => json(CRM),
        'GET /parties/:id': () => json({ message: 'Party not found' }, 404),
      },
    });
    expect(await screen.findByText('Could not load this customer')).toBeVisible();
  });

  it('edits a contract, sending every field', async () => {
    const changes: unknown[] = [];
    const { user } = renderApp({
      path: `/contracts/${CONTRACT.id}/edit`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /contracts/:id': () => json(CONTRACT),
        'GET /stores': () => json(STORES),
        'GET /members': () => json(MEMBERS),
        'GET /documents': () => json([]),
        'PATCH /contracts/:id': (request) => {
          changes.push(request.body);
          return json(CONTRACT);
        },
      },
    });
    expect(await screen.findByRole('heading', { name: 'Edit CT-000001', level: 1 })).toBeVisible();
    // The store decides who sees it, so it is not changed here.
    expect(screen.queryByRole('combobox', { name: 'Store' })).toBeNull();
    const value = screen.getByRole('textbox', { name: 'Value (₹)' });
    expect(value).toHaveValue('1000000.00');
    expect(await screen.findByRole('option', { name: 'Anil Kumar' })).toBeInTheDocument();
    await user.clear(value);
    await user.clear(screen.getByLabelText(/^Renewal reminder on/));
    await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'Call first');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Contract saved')).toBeVisible();
    expect(changes).toEqual([
      {
        type: 'contractor_agreement',
        title: 'Annual painting contract',
        startDate: '2025-11-01',
        endDate: '2026-10-31',
        valuePaise: null,
        terms: 'Paint supplied at 12% below MRP.\nDelivery within 3 days.',
        creditTerms: null,
        discountTerms: null,
        notes: 'Call first',
        assignedMemberId: 'member-1',
      },
    ]);
  });
});
