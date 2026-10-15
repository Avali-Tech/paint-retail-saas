import { SYSTEM_ROLES, type EarnRuleView } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CASHIER, OWNER, json, profile } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';

const BRANCH_MANAGER = profile(
  SYSTEM_ROLES.find((role) => role.key === 'branch_manager')?.permissions,
  { role: { key: 'branch_manager', name: 'Branch Manager' }, allStores: false },
);
const STORE_EMPLOYEE = profile(['parties:read', 'loyalty:read'], {
  role: { key: 'store_employee', name: 'Store Employee' },
  allStores: false,
});

const BRANDS = [
  { id: 'b-asian', name: 'Asian Paints', isActive: true },
  { id: 'b-berger', name: 'Berger', isActive: true },
];

const rule = (overrides: Partial<EarnRuleView> = {}): EarnRuleView => ({
  id: 'r1',
  name: 'Every brand',
  basis: 'value',
  points: 1,
  perPaise: 10_000,
  perMillilitres: null,
  brand: null,
  multiplierBps: 10_000,
  validFrom: null,
  validUntil: null,
  isActive: true,
  updatedAt: '2026-10-16T00:00:00.000Z',
  ...overrides,
});

const RULES: EarnRuleView[] = [
  rule(),
  rule({
    id: 'r2',
    name: 'Asian double',
    brand: { id: 'b-asian', name: 'Asian Paints' },
    multiplierBps: 20_000,
    validFrom: '2026-10-01',
    validUntil: '2026-10-31',
  }),
  rule({
    id: 'r3',
    name: 'Berger litres',
    basis: 'litre',
    points: 5,
    perPaise: null,
    perMillilitres: 1000,
    brand: { id: 'b-berger', name: 'Berger' },
    validFrom: '2026-11-01',
  }),
  rule({ id: 'r4', name: 'Old offer', isActive: false, validUntil: '2026-09-30' }),
];

describe('EarnRulesPage', { timeout: 30_000 }, () => {
  it('lists the rules in words', async () => {
    renderApp({
      path: '/settings/painter-points',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /loyalty-earn-rules': () => json(RULES),
      },
    });
    const table = await screen.findByRole('table', { name: 'Painter points rules' });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Every brand1 point per ₹100.00Every brandAlwaysOn');
    expect(rows[2]).toHaveTextContent(
      'Asian double1 point per ₹100.00 × 2Asian Paints1 Oct 2026 to 31 Oct 2026On',
    );
    expect(rows[3]).toHaveTextContent('Berger litres5 points per 1 LBergerFrom 1 Nov 2026On');
    expect(rows[4]).toHaveTextContent(
      'Old offer1 point per ₹100.00Every brandUntil 30 Sept 2026Off',
    );
  });

  it('adds a rule, checking the fields first', async () => {
    const saved: unknown[] = [];
    let rules: EarnRuleView[] = [];
    const { user } = renderApp({
      path: '/settings/painter-points',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /loyalty-earn-rules': () => json(rules),
        'GET /brands': () => json(BRANDS),
        'POST /loyalty-earn-rules': (request) => {
          saved.push(request.body);
          rules = [rule({ name: 'Berger litres' })];
          return json(rules[0], 201);
        },
      },
    });
    expect(
      await screen.findByText('No rules yet, so tagged painters earn no points.'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const dialog = screen.getByRole('dialog', { name: 'New earn rule' });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText('Enter a name of up to 100 characters')).toBeVisible();

    await user.type(within(dialog).getByRole('textbox', { name: 'Rule name' }), 'Berger litres');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Earn on' }), 'litre');
    const per = within(dialog).getByRole('textbox', { name: 'For every (litres)' });
    await user.clear(per);
    await user.type(per, '1');
    await user.clear(within(dialog).getByRole('textbox', { name: 'Points' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Points' }), '5');
    await waitFor(() => {
      expect(within(dialog).getByRole('option', { name: 'Berger' })).toBeInTheDocument();
    });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Brand' }), 'b-berger');
    await user.clear(within(dialog).getByRole('textbox', { name: 'Multiplier' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Multiplier' }), '1.5');
    await user.type(within(dialog).getByLabelText('Until (optional)'), '2026-12-31');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Earn rule saved')).toBeVisible();
    expect(saved).toEqual([
      {
        name: 'Berger litres',
        basis: 'litre',
        points: 5,
        perPaise: null,
        perMillilitres: 1000,
        brandId: 'b-berger',
        multiplierBps: 15_000,
        validFrom: null,
        validUntil: '2026-12-31',
        isActive: true,
      },
    ]);
    expect(await screen.findByRole('table', { name: 'Painter points rules' })).toBeVisible();
  });

  it('changes a rule, back to value and switched off', async () => {
    const saved: unknown[] = [];
    const { user } = renderApp({
      path: '/settings/painter-points',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /loyalty-earn-rules': () => json(RULES),
        'GET /brands': () => json(BRANDS),
        'PUT /loyalty-earn-rules/:id': (request) => {
          saved.push([request.path, request.body]);
          return json(RULES[2]);
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Edit Berger litres' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit earn rule' });
    expect(within(dialog).getByRole('textbox', { name: 'For every (litres)' })).toHaveValue('1');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Earn on' }), 'value');
    const per = within(dialog).getByRole('textbox', { name: 'For every (₹)' });
    await user.clear(per);
    await user.type(per, '200');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Rule is on' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(saved).toEqual([
        [
          '/loyalty-earn-rules/r3',
          expect.objectContaining({
            basis: 'value',
            perPaise: 20_000,
            perMillilitres: null,
            brandId: 'b-berger',
            validFrom: '2026-11-01',
            isActive: false,
          }),
        ],
      ]);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is read-only for store-level managers and roles without loyalty:manage', async () => {
    const { unmount } = renderApp({
      path: '/settings/painter-points',
      routes: {
        'GET /auth/me': () => json(BRANCH_MANAGER),
        'GET /loyalty-earn-rules': () => json(RULES),
      },
    });
    expect(
      await screen.findByText('Only members who work at every store can change the rules.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add rule' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Every brand' })).toBeNull();
    unmount();

    renderApp({
      path: '/settings/painter-points',
      routes: {
        'GET /auth/me': () => json(STORE_EMPLOYEE),
        'GET /loyalty-earn-rules': () => json(RULES),
      },
    });
    expect(
      await screen.findByText('Your role can see the rules but not change them.'),
    ).toBeVisible();
  });

  it('shows a failure to load, and is closed to roles without loyalty access', async () => {
    const { unmount } = renderApp({
      path: '/settings/painter-points',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /loyalty-earn-rules': () => json({ message: 'Database down' }, 503),
      },
    });
    expect(await screen.findByText('Could not load the earn rules')).toBeVisible();
    unmount();
    renderApp({
      path: '/settings/painter-points',
      routes: { 'GET /auth/me': () => json(CASHIER) },
    });
    expect(await screen.findByText('No access')).toBeVisible();
  });
});
