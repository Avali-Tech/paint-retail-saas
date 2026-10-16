import { PERMISSIONS } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Role, RoleInput } from '../api/team.js';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import {
  CASHIER_ROLE,
  MANAGER_ROLE,
  OWNER_ROLE,
  ROLES,
  allBut,
} from '../team/test-support/fixtures.js';
import { PERMISSION_GROUPS, PERMISSION_LABELS } from './permission-groups.js';

const ADMIN = profile(allBut('audit:read'), {
  role: { key: 'org_admin', name: 'Organization Admin' },
});
const MANAGER = profile([...MANAGER_ROLE.permissions], {
  role: { key: 'branch_manager', name: 'Branch Manager' },
  allStores: false,
  storeIds: ['store-hyd'],
});

function renderRoles(path: string, me: unknown, routes: Record<string, FakeHandler> = {}) {
  return renderApp({
    path,
    routes: { 'GET /auth/me': () => json(me), 'GET /roles': () => json(ROLES), ...routes },
  });
}

describe('permission groups', () => {
  it('puts every permission in exactly one area, with a label', () => {
    expect(PERMISSION_GROUPS.flatMap((group) => group.permissions).sort()).toEqual(
      [...PERMISSIONS].sort(),
    );
    expect(PERMISSION_GROUPS.every((group) => group.permissions.length > 0)).toBe(true);
    expect(Object.keys(PERMISSION_LABELS).sort()).toEqual([...PERMISSIONS].sort());
  });
});

describe('roles list', () => {
  it('lists system and custom roles with their permissions and members', async () => {
    renderRoles('/team/roles', OWNER);
    const table = await screen.findByRole('table', { name: 'Roles' });
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['Organization Admin', 'System', '40 of 40', '1'],
      ['Branch Manager', 'System', '27 of 40', '1'],
      ['Cashier', 'Custom', '2 of 40', '0'],
      ['Owner', 'System', '40 of 40', '1'],
      ['Store Employee', 'System', '8 of 40', '1'],
    ]);
    expect(screen.getByRole('link', { name: '+ Role' })).toHaveAttribute('href', '/team/roles/new');
  });

  it('shows the roles without a way to add one to a branch manager', async () => {
    renderRoles('/team/roles', MANAGER);
    await screen.findByRole('table', { name: 'Roles' });
    expect(screen.queryByRole('link', { name: '+ Role' })).toBeNull();
  });
});

describe('creating a role', () => {
  it('checks the name and permissions, greys out what the admin lacks, and creates it', async () => {
    const created: Role = {
      ...CASHIER_ROLE,
      id: 'role-new',
      name: 'Godown keeper',
      permissions: ['inventory:read', 'stores:read'],
    };
    let roles = ROLES;
    let answer: FakeHandler = () =>
      json({ statusCode: 409, message: 'A role with this name already exists' }, 409);
    const { user, requests } = renderRoles('/team/roles/new', ADMIN, {
      'GET /roles': () => json(roles),
      'POST /roles': (request) => answer(request),
    });
    expect(await screen.findByRole('heading', { name: 'New role', level: 1 })).toBeVisible();
    const audit = screen.getByRole('checkbox', { name: 'See the audit log' });
    expect(audit).toBeDisabled();
    expect(audit).toHaveAccessibleDescription(
      'Permissions you do not have yourself are greyed out: nobody can give what they do not hold.',
    );
    expect(screen.getByRole('group', { name: 'Stock' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create role' }));
    expect(screen.getByText('Use 2 to 60 characters')).toBeInTheDocument();
    expect(screen.getByText('Choose at least one permission')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /Role name/ }), '  Godown keeper ');
    const stock = screen.getByRole('group', { name: 'Stock' });
    await user.click(
      within(stock).getByRole('checkbox', { name: 'See stock, transfers and stock counts' }),
    );
    await user.click(screen.getByRole('checkbox', { name: 'See stores' }));
    await user.click(screen.getByRole('checkbox', { name: 'Add stores and godowns' }));
    await user.click(screen.getByRole('checkbox', { name: 'Add stores and godowns' }));
    await user.click(screen.getByRole('button', { name: 'Create role' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A role with this name already exists',
    );

    answer = () => {
      roles = [...ROLES, created];
      return json(created, 201);
    };
    await user.click(screen.getByRole('button', { name: 'Create role' }));
    expect(await screen.findByText('Role Godown keeper created')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Godown keeper', level: 1 })).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent('/team/roles/role-new');
    const sent = requests.filter((request) => request.method === 'POST').at(-1)?.body as RoleInput;
    expect(sent).toEqual({ name: 'Godown keeper', permissions: ['inventory:read', 'stores:read'] });
  });

  it('is closed to those who cannot manage roles', async () => {
    renderRoles('/team/roles/new', MANAGER);
    expect(await screen.findByText('No access')).toBeInTheDocument();
  });
});

describe('a role', () => {
  it('shows a system role read-only', async () => {
    renderRoles(`/team/roles/${OWNER_ROLE.id}`, OWNER);
    expect(await screen.findByRole('heading', { name: 'Owner', level: 1 })).toBeVisible();
    expect(
      screen.getByText(
        'System roles come with the app and cannot be changed. Create a custom role instead.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Role name/ })).toHaveAttribute('readonly');
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(PERMISSIONS.length);
    expect(
      boxes.every((box) => box instanceof HTMLInputElement && box.checked && box.disabled),
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save role' })).toBeNull();
  });

  it('changes a custom role’s name and permissions', async () => {
    let roles = ROLES;
    let answer: FakeHandler = () =>
      json({ statusCode: 403, message: 'You cannot change your own role' }, 403);
    const { user, requests } = renderRoles(`/team/roles/${CASHIER_ROLE.id}`, OWNER, {
      'GET /roles': () => json(roles),
      'PATCH /roles/:id': (request) => answer(request),
    });
    expect(await screen.findByRole('heading', { name: 'Cashier', level: 1 })).toBeVisible();
    expect(screen.getByText('Custom')).toBeInTheDocument();
    expect(
      screen.getByText('Changes apply to everyone with this role from their next action.'),
    ).toBeInTheDocument();
    const name = screen.getByRole('textbox', { name: /Role name/ });
    await user.clear(name);
    await user.type(name, 'Senior cashier');
    await user.click(screen.getByRole('checkbox', { name: 'See customers and other parties' }));
    await user.click(screen.getByRole('checkbox', { name: 'See loyalty points' }));
    await user.click(screen.getByRole('button', { name: 'Save role' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot change your own role');

    answer = (request) => {
      const body = request.body as RoleInput;
      const saved: Role = { ...CASHIER_ROLE, name: body.name, permissions: [...body.permissions] };
      roles = ROLES.map((role) => (role.id === saved.id ? saved : role));
      return json(saved);
    };
    await user.click(screen.getByRole('button', { name: 'Save role' }));
    expect(await screen.findByText('Role saved')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Senior cashier', level: 1 })).toBeVisible();
    });
    expect(requests.filter((request) => request.method === 'PATCH').at(-1)?.body).toEqual({
      name: 'Senior cashier',
      permissions: ['stores:read', 'loyalty:read'],
    });
  });

  it('shows a custom role read-only to those who cannot manage roles', async () => {
    renderRoles(`/team/roles/${CASHIER_ROLE.id}`, MANAGER);
    expect(
      await screen.findByText('You can see this role but your role cannot change roles.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'See stores' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save role' })).toBeNull();
  });

  it('says when a role does not exist', async () => {
    const { user } = renderRoles('/team/roles/role-gone', OWNER);
    expect(await screen.findByText('This role does not exist.')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Back to roles' }));
    expect(await screen.findByRole('table', { name: 'Roles' })).toBeInTheDocument();
  });
});
