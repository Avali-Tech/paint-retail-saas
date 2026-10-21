import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MemberInput } from '../api/team.js';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { found } from '../test-support/found.js';
import { STORES } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import {
  ADMIN_ROLE,
  CASHIER_ROLE,
  EMPLOYEE_ROLE,
  MANAGER_ROLE,
  ME,
  MEMBERS,
  OLD,
  OWNER_ROLE,
  PRIYA,
  ROLES,
  SURESH,
  allBut,
  member,
} from './test-support/fixtures.js';

const ADMIN = profile(allBut('audit:read'), {
  role: { key: 'org_admin', name: 'Organization Admin' },
});
const MANAGER = profile([...MANAGER_ROLE.permissions], {
  role: { key: 'branch_manager', name: 'Branch Manager' },
  allStores: false,
  storeIds: ['store-hyd'],
});

function renderTeam(path: string, me: unknown, routes: Record<string, FakeHandler> = {}) {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(me),
      'GET /members': () => json(MEMBERS),
      'GET /roles': () => json(ROLES),
      'GET /stores': () => json(STORES),
      ...routes,
    },
  });
}

const rowTexts = () =>
  within(screen.getByRole('table', { name: 'Team members' }))
    .getAllByRole('row')
    .slice(1)
    .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent));

describe('team list', () => {
  it('lists active members with role, stores, status and two-factor sign-in', async () => {
    const { user } = renderTeam('/team', OWNER);
    expect(await screen.findByRole('heading', { name: 'Team', level: 1 })).toBeVisible();
    await screen.findByRole('table', { name: 'Team members' });
    await waitFor(() => {
      expect(rowTexts()).toEqual([
        ['Anil Kumar You+919876543210', 'Owner', 'All stores', 'Active', 'On'],
        ['Priya Managerpriya@abc.in', 'Branch Manager', 'HYD, PUN, 1 other store', 'Active', 'On'],
        ['Suresh Counter+919876500001', 'Store Employee', 'HYD', 'Active', 'Off'],
      ]);
    });
    expect(screen.getByRole('link', { name: '+ Team member' })).toHaveAttribute(
      'href',
      '/team/new',
    );
    const sections = screen.getByRole('navigation', { name: 'Team sections' });
    expect(within(sections).getByRole('link', { name: 'Roles and permissions' })).toHaveAttribute(
      'href',
      '/team/roles',
    );

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'inactive');
    expect(rowTexts()).toEqual([
      ['Old Staff+919876500001', 'Store Employee', 'No stores', 'Inactive', 'Off'],
    ]);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'all');
    expect(rowTexts()).toHaveLength(4);

    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'PRIYA abc');
    expect(rowTexts().map((row) => row[0])).toEqual(['Priya Managerpriya@abc.in']);
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), ' nobody');
    expect(screen.getByText('No team members match')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/team?status=all&q=PRIYA+abc+nobody');
  });

  it('hides adding people from those who cannot, and names unknown stores by count', async () => {
    renderTeam('/team', MANAGER, {
      'GET /stores': () => json({ statusCode: 503, message: 'Down' }, 503),
    });
    await screen.findByRole('table', { name: 'Team members' });
    expect(rowTexts()[1]?.[2]).toBe('3 other stores');
    expect(screen.queryByRole('link', { name: '+ Team member' })).toBeNull();
    // The Team entry is in the navigation for members:read.
    expect(
      within(found(screen.getAllByRole('navigation', { name: 'Main' })[0])).getByRole('link', {
        name: 'Team',
      }),
    ).toHaveAttribute('href', '/team');
  });

  it('offers a retry when the team cannot load', async () => {
    let attempts = 0;
    const { user } = renderTeam('/team', OWNER, {
      'GET /members': () => {
        attempts += 1;
        return attempts === 1 ? json({ message: 'Database down' }, 503) : json([SURESH]);
      },
    });
    expect(await screen.findByText('Database down')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Suresh Counter' })).toBeInTheDocument();
  });

  it('tells counter staff the team is not for their role', async () => {
    renderTeam('/team', profile(['stores:read']));
    expect(await screen.findByText('No access')).toBeInTheDocument();
  });
});

describe('adding a team member', () => {
  it('checks the form, offers only roles the admin may give, and adds the person', async () => {
    let answer: FakeHandler = (request) => {
      const body = request.body as MemberInput;
      return json(
        member('m-new', body.fullName, CASHIER_ROLE, { storeIds: [...body.storeIds] }),
        201,
      );
    };
    const { user, requests } = renderTeam('/team/new', ADMIN, {
      'POST /members': (request) => answer(request),
      'GET /members/:id': () => json(member('m-new', 'Ravi Teja', CASHIER_ROLE)),
    });
    expect(
      await screen.findByRole('heading', { name: 'Add a team member', level: 1 }),
    ).toBeVisible();
    const role = screen.getByRole('combobox', { name: /Role/ });
    await waitFor(() => {
      expect(
        within(role)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual([
        // Not Organization Admin: this admin lacks audit:read, so cannot give it.
        'Choose a role',
        'Branch Manager',
        'Cashier',
        'Store Employee',
      ]);
    });

    await user.click(screen.getByRole('button', { name: 'Add member' }));
    expect(await screen.findByText('Enter a name of 2 to 120 characters')).toBeInTheDocument();
    expect(screen.getByText('Enter a mobile number or an email address')).toBeInTheDocument();
    expect(screen.getByText('Choose a role', { selector: '.ui-field__error' })).toBeInTheDocument();
    expect(screen.getByText('Choose at least one store, or all stores')).toBeInTheDocument();
    expect(requests.some((request) => request.method === 'POST')).toBe(false);

    await user.type(screen.getByRole('textbox', { name: /Full name/ }), 'Ravi Teja');
    await user.type(screen.getByRole('textbox', { name: 'Mobile number' }), '12345');
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'not-an-email');
    await user.type(screen.getByLabelText('Password (optional)'), 'short');
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    expect(await screen.findByText('Enter a 10-digit mobile number')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    expect(screen.getByText('Use at least 8 characters')).toBeInTheDocument();

    await user.clear(screen.getByRole('textbox', { name: 'Mobile number' }));
    await user.type(screen.getByRole('textbox', { name: 'Mobile number' }), '98765 43210');
    await user.clear(screen.getByRole('textbox', { name: 'Email' }));
    await user.clear(screen.getByLabelText('Password (optional)'));
    await user.selectOptions(role, 'Cashier');
    const access = screen.getByRole('group', { name: 'Store access' });
    await user.click(within(access).getByRole('checkbox', { name: 'HYD · Hyderabad' }));
    await user.click(within(access).getByRole('checkbox', { name: 'PUN · Pune' }));
    await user.click(within(access).getByRole('checkbox', { name: 'PUN · Pune' }));

    answer = () =>
      json(
        {
          statusCode: 400,
          message: 'Validation failed',
          issues: [{ path: 'phone', message: 'Enter a valid Indian mobile number' }],
        },
        400,
      );
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    expect(await screen.findByText('Enter a valid Indian mobile number')).toBeInTheDocument();

    answer = () =>
      json({ statusCode: 403, message: 'You cannot give permissions you do not have' }, 403);
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You cannot give permissions you do not have',
    );

    answer = (request) => {
      const body = request.body as MemberInput;
      return json(member('m-new', body.fullName, CASHIER_ROLE), 201);
    };
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    expect(await screen.findByText('Ravi Teja is now on the team')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/team/m-new');
    });
    expect(requests.filter((request) => request.method === 'POST').at(-1)?.body).toEqual({
      fullName: 'Ravi Teja',
      phone: '98765 43210',
      roleId: CASHIER_ROLE.id,
      allStores: false,
      storeIds: ['store-hyd'],
    });
  });

  it('adds someone by email with a password and access to every store', async () => {
    const { user, requests } = renderTeam('/team/new', OWNER, {
      'POST /members': () => json(member('m-new', 'Kiran Admin', ADMIN_ROLE), 201),
      'GET /members/:id': () => json(member('m-new', 'Kiran Admin', ADMIN_ROLE)),
    });
    const role = await screen.findByRole('combobox', { name: /Role/ });
    // Owners may make owners.
    await waitFor(() => {
      expect(within(role).getByRole('option', { name: 'Owner' })).toBeInTheDocument();
    });
    await user.type(screen.getByRole('textbox', { name: /Full name/ }), 'Kiran Admin');
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'kiran@abc.in');
    await user.type(screen.getByLabelText('Password (optional)'), 'Kiran@2026');
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    expect(
      await screen.findByText('Choose a role', { selector: '.ui-field__error' }),
    ).toBeVisible();
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
    await user.selectOptions(role, 'Organization Admin');
    await user.click(
      screen.getByRole('checkbox', { name: 'All stores, including stores added later' }),
    );
    expect(screen.queryByRole('checkbox', { name: 'HYD · Hyderabad' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    expect(await screen.findByText('Kiran Admin is now on the team')).toBeInTheDocument();
    expect(requests.find((request) => request.method === 'POST')?.body).toEqual({
      fullName: 'Kiran Admin',
      email: 'kiran@abc.in',
      password: 'Kiran@2026',
      roleId: ADMIN_ROLE.id,
      allStores: true,
      storeIds: [],
    });
  });
});

describe('a member’s page', () => {
  it('changes role and stores, showing the API’s refusals', async () => {
    let answer: FakeHandler = () =>
      json({ statusCode: 403, message: 'You cannot give access to stores you cannot access' }, 403);
    let current = SURESH;
    const { user, requests } = renderTeam(`/team/${SURESH.id}`, OWNER, {
      'GET /members/:id': () => json(current),
      'PATCH /members/:id': (request) => answer(request),
    });
    expect(await screen.findByRole('heading', { name: 'Suresh Counter', level: 1 })).toBeVisible();
    const contact = screen.getByRole('region', { name: 'Contact' });
    expect(within(contact).getByText('+919876500001')).toBeInTheDocument();
    expect(within(contact).getByText('—')).toBeInTheDocument();
    await waitFor(() => {
      expect(within(contact).getByText('HYD')).toBeInTheDocument();
    });

    const access = screen.getByRole('region', { name: 'Role and stores' });
    const role = within(access).getByRole('combobox', { name: /Role/ });
    await waitFor(() => {
      expect(role).toHaveValue(EMPLOYEE_ROLE.id);
    });
    await user.click(within(access).getByRole('checkbox', { name: 'HYD · Hyderabad' }));
    await user.click(within(access).getByRole('button', { name: 'Save changes' }));
    expect(
      within(access).getByText('Choose at least one store, or all stores'),
    ).toBeInTheDocument();
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);

    await user.click(within(access).getByRole('checkbox', { name: 'PUN · Pune' }));
    await user.selectOptions(role, 'Branch Manager');
    await user.click(within(access).getByRole('button', { name: 'Save changes' }));
    expect(await within(access).findByRole('alert')).toHaveTextContent(
      'You cannot give access to stores you cannot access',
    );

    answer = (request) => {
      current = {
        ...SURESH,
        role: { id: MANAGER_ROLE.id, key: MANAGER_ROLE.key, name: MANAGER_ROLE.name },
        storeIds: ['store-pun'],
      };
      return json({ ...current, ...(request.body as object) });
    };
    await user.click(within(access).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes saved')).toBeInTheDocument();
    expect(requests.filter((request) => request.method === 'PATCH').at(-1)?.body).toEqual({
      roleId: MANAGER_ROLE.id,
      allStores: false,
      storeIds: ['store-pun'],
    });
    expect(screen.getByRole('heading', { name: 'Suresh Counter', level: 1 })).toBeVisible();

    // The form starts again from what was saved.
    const saved = screen.getByRole('region', { name: 'Role and stores' });
    await user.click(
      within(saved).getByRole('checkbox', { name: 'All stores, including stores added later' }),
    );
    await user.click(within(saved).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(requests.filter((request) => request.method === 'PATCH').at(-1)?.body).toEqual({
        roleId: MANAGER_ROLE.id,
        allStores: true,
        storeIds: [],
      });
    });
  });

  it('grants and denies permissions on top of the role, and says why saving failed', async () => {
    let answer: FakeHandler = () =>
      json({ statusCode: 403, message: 'You cannot give permissions you do not have' }, 403);
    const { user, requests } = renderTeam(`/team/${SURESH.id}`, ADMIN, {
      'GET /members/:id': () => json(SURESH),
      'PATCH /members/:id': (request) => answer(request),
    });
    const card = await screen.findByRole('region', { name: 'Exceptions to the role' });
    const costs = within(card).getByRole('combobox', {
      name: 'See costs: average cost, stock value at cost and margins',
    });
    const cancel = within(card).getByRole('combobox', {
      name: 'Cancel an invoice on the day it was issued',
    });
    await waitFor(() => {
      expect(within(costs).getByRole('option', { name: 'As the role: allowed' })).toBeVisible();
    });
    expect(within(cancel).getByRole('option', { name: 'As the role: not allowed' })).toBeVisible();
    // Nobody can allow what they do not hold: this admin has no audit:read.
    const audit = within(card).getByRole('combobox', { name: 'See the audit log' });
    expect(within(audit).getByRole('option', { name: 'Allow' })).toBeDisabled();

    await user.selectOptions(costs, 'deny');
    await user.selectOptions(cancel, 'allow');
    await user.selectOptions(audit, 'deny');
    await user.selectOptions(audit, 'role');
    expect(within(card).getByText('1 allowed, 1 denied beyond the role')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Save exceptions' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent(
      'You cannot give permissions you do not have',
    );

    answer = (request) => json({ ...SURESH, ...(request.body as object) });
    await user.click(within(card).getByRole('button', { name: 'Save exceptions' }));
    expect(await screen.findByText('Exceptions saved')).toBeInTheDocument();
    expect(requests.filter((request) => request.method === 'PATCH').at(-1)?.body).toEqual({
      exceptions: { granted: ['billing:cancel'], denied: ['costs:read'] },
    });
  });

  it('shows no exceptions for an owner', async () => {
    const coOwner = member('m-co', 'Co Owner', OWNER_ROLE, { allStores: true, storeIds: [] });
    renderTeam(`/team/${coOwner.id}`, OWNER, { 'GET /members/:id': () => json(coOwner) });
    expect(
      await screen.findByText('Owners hold every permission, with no exceptions.'),
    ).toBeInTheDocument();
  });

  it('shows a branch manager the exceptions without a way to change them', async () => {
    renderTeam(`/team/${SURESH.id}`, MANAGER, {
      'GET /members/:id': () =>
        json({ ...SURESH, exceptions: { granted: [], denied: ['billing:discount'] } }),
    });
    const card = await screen.findByRole('region', { name: 'Exceptions to the role' });
    const discount = within(card).getByRole('combobox', {
      name: 'Give discounts and change prices on bills, quotations and orders',
    });
    expect(discount).toHaveValue('deny');
    expect(discount).toBeDisabled();
    expect(within(card).queryByRole('button', { name: 'Save exceptions' })).toBeNull();
  });

  it('deactivates after confirming, and reactivates', async () => {
    let current = SURESH;
    let fail = true;
    const { user, requests } = renderTeam(`/team/${SURESH.id}`, OWNER, {
      'GET /members/:id': () => json(current),
      'PATCH /members/:id': (request) => {
        if (fail)
          return json({ statusCode: 403, message: 'You cannot change your own access' }, 403);
        current = { ...current, ...(request.body as { isActive: boolean }) };
        return json(current);
      },
    });
    const status = await screen.findByRole('region', { name: 'Status' });
    expect(within(status).getByText('Can sign in and work.')).toBeInTheDocument();
    await user.click(within(status).getByRole('button', { name: 'Deactivate' }));
    let dialog = screen.getByRole('dialog', { name: 'Deactivate Suresh Counter?' });
    expect(dialog).toHaveAccessibleDescription(
      'They are signed out at once and cannot sign in until they are reactivated. Their history stays.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(within(status).getByRole('button', { name: 'Deactivate' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(within(status).getByRole('button', { name: 'Deactivate' }));
    dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByText('You cannot change your own access')).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();

    fail = false;
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByText('Suresh Counter deactivated')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(status).getByText('Cannot sign in. Their history is kept.')).toBeInTheDocument();

    await user.click(within(status).getByRole('button', { name: 'Reactivate' }));
    expect(await screen.findByText('Suresh Counter reactivated')).toBeInTheDocument();
    expect(
      requests.filter((request) => request.method === 'PATCH').map((request) => request.body),
    ).toEqual([{ isActive: false }, { isActive: false }, { isActive: true }]);
  });

  it('lets an owner reset someone’s two-factor sign-in after confirming', async () => {
    let answer: ReturnType<FakeHandler> = json(
      { statusCode: 403, message: 'Only an owner can reset two-factor sign-in' },
      403,
    );
    const { user, requests } = renderTeam(`/team/${PRIYA.id}`, OWNER, {
      'GET /members/:id': () => json(PRIYA),
      'POST /members/:id/two-factor/reset': () => answer,
    });
    const card = await screen.findByRole('region', { name: 'Two-factor sign-in' });
    expect(within(card).getByText('On')).toBeInTheDocument();
    expect(
      within(card).getByText('Signs in with a code from an authenticator app.'),
    ).toBeInTheDocument();
    // Email but no mobile number.
    const contact = screen.getByRole('region', { name: 'Contact' });
    expect(within(contact).getByText('priya@abc.in')).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Reset two-factor' }));
    let dialog = screen.getByRole('dialog', {
      name: 'Reset two-factor sign-in for Priya Manager?',
    });
    expect(dialog).toHaveAccessibleDescription(
      'Their authenticator app and recovery codes are removed and they are signed out. This is recorded in the audit log.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Reset two-factor' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(within(card).getByRole('button', { name: 'Reset two-factor' }));
    dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reset' }));
    expect(
      await screen.findByText('Only an owner can reset two-factor sign-in'),
    ).toBeInTheDocument();

    answer = { status: 204 };
    await user.click(within(dialog).getByRole('button', { name: 'Reset' }));
    expect(
      await screen.findByText('Two-factor sign-in reset for Priya Manager'),
    ).toBeInTheDocument();
    expect(within(card).getByText('Off')).toBeInTheDocument();
    expect(within(card).getByText('Does not use an authenticator app.')).toBeInTheDocument();
    expect(requests.filter((request) => request.path.endsWith('/two-factor/reset')).length).toBe(2);
  });

  it('shows your own page without ways to change your access', async () => {
    renderTeam(`/team/${ME.id}`, OWNER, { 'GET /members/:id': () => json(ME) });
    expect(
      await screen.findByText('You cannot change your own access. Ask another owner or admin.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Role/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset two-factor' })).toBeNull();
  });

  it('is read-only for a branch manager, who also cannot give all-store access', async () => {
    renderTeam(`/team/${ME.id}`, MANAGER, {
      'GET /members/:id': () => json({ ...ME, user: { ...ME.user, id: 'user-owner' } }),
    });
    expect(
      await screen.findByText('Your role can see this person’s access but not change it.'),
    ).toBeInTheDocument();
    const access = screen.getByRole('region', { name: 'Role and stores' });
    expect(within(access).getByText('All stores')).toBeInTheDocument();
    expect(within(access).queryByRole('checkbox')).toBeNull();
    // Their current role is listed although a manager could not give it.
    await waitFor(() => {
      expect(within(access).getByRole('combobox', { name: /Role/ })).toHaveValue(OWNER_ROLE.id);
    });
    expect(screen.queryByRole('button', { name: 'Reactivate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset two-factor' })).toBeNull();
  });

  it('lists a closed store the member still has', async () => {
    renderTeam(`/team/${OLD.id}`, OWNER, {
      'GET /members/:id': () => json({ ...OLD, storeIds: ['store-old'] }),
      'GET /stores': () =>
        json([
          ...STORES,
          { ...STORES[0], id: 'store-old', code: 'OLD', name: 'Old', isActive: false },
        ]),
    });
    expect(await screen.findByRole('checkbox', { name: 'OLD · Old' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  it('says when a member cannot be seen', async () => {
    renderTeam('/team/m-gone', OWNER, {
      'GET /members/:id': () => json({ statusCode: 404, message: 'Member not found' }, 404),
    });
    expect(
      await screen.findByText('This record does not exist, or you cannot see it.'),
    ).toBeInTheDocument();
  });
});
