import { DEFAULT_CREDIT_RULES, SYSTEM_ROLES } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import { CREDIT_REQUEST, DECIDED_REQUEST, PARTY } from '../test-support/party-fixtures.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import { PAGE_SIZE } from './CreditRequestsPage.js';

const SALES = profile(SYSTEM_ROLES.find((role) => role.key === 'sales_executive')?.permissions, {
  role: { key: 'sales_executive', name: 'Sales Executive' },
});
const location = () => screen.getByTestId('location').textContent;

describe('CreditRequestsPage', { timeout: 30_000 }, () => {
  it('lists waiting requests for approvers to decide, and other statuses on request', async () => {
    const { user, requests } = renderApp({
      path: '/credit-requests',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /credit-requests': (request) =>
          request.query.get('status') === 'pending'
            ? json({ items: [CREDIT_REQUEST], total: 1 })
            : json({ items: [CREDIT_REQUEST, DECIDED_REQUEST], total: 2 }),
        'POST /credit-requests/:id/approve': () => json(CREDIT_REQUEST),
      },
    });
    const table = await screen.findByRole('table', { name: 'Credit requests' });
    expect(requests.at(-1)?.query.toString()).toBe('status=pending&limit=50&offset=0');
    const [, row] = within(table).getAllByRole('row');
    expect(within(found(row)).getByRole('link', { name: 'CR-000001' })).toHaveAttribute(
      'href',
      `/credit-requests/${CREDIT_REQUEST.id}`,
    );
    expect(within(found(row)).getByRole('link', { name: 'Apex Builders' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}`,
    );
    expect(row).toHaveTextContent(
      '₹1,00,000.00 · 45 days₹50,000.00 · 30 daysVikram Sales28 Sept 2026Waiting',
    );

    await user.click(screen.getByRole('button', { name: 'Approve CR-000001' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Credit approved')).toBeVisible();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'All requests');
    await waitFor(() => {
      expect(location()).toBe('/credit-requests?status=all');
    });
    expect(await screen.findByRole('link', { name: 'CR-000002' })).toBeVisible();
    expect(requests.at(-1)?.query.toString()).toBe('limit=50&offset=0');
    // Only waiting requests can be decided.
    expect(screen.getAllByRole('button', { name: /^Approve/ })).toHaveLength(1);
  });

  it('says why the member cannot decide a request they asked for', async () => {
    const { user } = renderApp({
      path: '/credit-requests',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /credit-requests': () => json({ items: [CREDIT_REQUEST], total: 1 }),
        'POST /credit-requests/:id/approve': () =>
          json(
            {
              statusCode: 403,
              message: 'You asked for this credit request: another approver decides it',
            },
            403,
          ),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Approve CR-000001' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve' }));
    expect(
      await within(screen.getByRole('dialog')).findByText(
        'You asked for this credit request: another approver decides it',
      ),
    ).toBeVisible();
  });

  it('pages, explains an empty list and hides deciding from those who cannot', async () => {
    let total = PAGE_SIZE + 1;
    const { user } = renderApp({
      path: '/credit-requests?status=rejected',
      routes: {
        'GET /auth/me': () => json(SALES),
        'GET /credit-requests': (request) =>
          request.query.get('offset') === '0'
            ? json({ items: [CREDIT_REQUEST], total })
            : json({ items: [], total: (total = 0) }),
      },
    });
    await screen.findByRole('table', { name: 'Credit requests' });
    expect(screen.queryByRole('columnheader', { name: 'Decide' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve CR-000001' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('rejected');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('No credit requests here')).toBeVisible();
  });

  it('shows a failure', async () => {
    renderApp({
      path: '/credit-requests',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /credit-requests': () => json({ message: 'Database down' }, 503),
      },
    });
    expect(await screen.findByText('Could not load credit requests')).toBeVisible();
  });
});

describe('CreditRequestPage', { timeout: 30_000 }, () => {
  it('shows a waiting request with its decision buttons', async () => {
    const { user } = renderApp({
      path: `/credit-requests/${CREDIT_REQUEST.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /credit-requests/:id': () => json(CREDIT_REQUEST),
        'POST /credit-requests/:id/reject': () => json(CREDIT_REQUEST),
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'CR-000001 · Credit request', level: 1 }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Apex Builders' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}`,
    );
    const details = screen.getByRole('region', { name: 'Details' });
    expect(within(details).getByText('Big order coming')).toBeVisible();
    expect(within(details).getByText('Vikram Sales · 28 Sept 2026, 11:30 am')).toBeVisible();
    expect(within(details).queryByText('Decided by')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reject CR-000001' }));
    await user.type(within(screen.getByRole('dialog')).getByRole('textbox'), 'Too risky');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Request rejected')).toBeVisible();
  });

  it('shows who decided a request, without buttons', async () => {
    renderApp({
      path: `/credit-requests/${DECIDED_REQUEST.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /credit-requests/:id': () => json({ ...DECIDED_REQUEST, decisionNote: null }),
      },
    });
    const details = await screen.findByRole('region', { name: 'Details' });
    expect(within(details).getByText('Approved')).toBeVisible();
    expect(within(details).getByText('Anil Kumar · 29 Sept 2026, 11:30 am')).toBeVisible();
    expect(within(details).getAllByText('—')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });

  it('says when the request cannot be seen', async () => {
    renderApp({
      path: `/credit-requests/${CREDIT_REQUEST.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /credit-requests/:id': () => json({ message: 'Credit request not found' }, 404),
      },
    });
    expect(await screen.findByText('Could not load this credit request')).toBeVisible();
  });
});

describe('CreditRulesPage', { timeout: 30_000 }, () => {
  it('lets approvers change when credit sales need approval, checking the numbers', async () => {
    const saved: unknown[] = [];
    let calls = 0;
    const { user } = renderApp({
      path: '/settings/credit',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /credit-rules': () => json(DEFAULT_CREDIT_RULES),
        'PUT /credit-rules': (request) => {
          calls += 1;
          saved.push(request.body);
          return calls === 1 ? json({ message: 'Database down' }, 503) : json(request.body);
        },
      },
    });
    const normal = await screen.findByRole('textbox', { name: 'Sell normally up to (% of limit)' });
    const manager = screen.getByRole('textbox', { name: 'Manager approves up to (% of limit)' });
    const overdue = screen.getByRole('textbox', { name: 'Block credit after (days overdue)' });
    expect(normal).toHaveValue('80');
    expect(manager).toHaveValue('100');
    expect(overdue).toHaveValue('30');

    await user.clear(normal);
    await user.type(normal, 'most');
    await user.clear(overdue);
    await user.type(overdue, '0');
    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(await screen.findByText('Enter a whole percentage from 0 to 1000')).toBeVisible();
    expect(screen.getByText('Enter 1 to 3650 days')).toBeVisible();

    await user.clear(normal);
    await user.type(normal, '120');
    await user.clear(overdue);
    await user.type(overdue, '45');
    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(
      await screen.findByText('Manager approval must start at or above the normal limit'),
    ).toBeVisible();

    await user.clear(manager);
    await user.type(manager, '150');
    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(await screen.findByText('Database down')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(await screen.findByText('Credit rules saved')).toBeVisible();
    expect(saved).toEqual([
      { normalUpToPercent: 120, managerUpToPercent: 150, holdAfterOverdueDays: 45 },
      { normalUpToPercent: 120, managerUpToPercent: 150, holdAfterOverdueDays: 45 },
    ]);
  });

  it('only shows the rules to members who cannot approve credit', async () => {
    renderApp({
      path: '/settings/credit',
      routes: {
        'GET /auth/me': () => json(SALES),
        'GET /credit-rules': () => json(DEFAULT_CREDIT_RULES),
      },
    });
    expect(await screen.findByText('Only owners and admins can change these rules.')).toBeVisible();
    expect(
      screen.getByRole('textbox', { name: 'Sell normally up to (% of limit)' }),
    ).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save rules' })).toBeNull();
  });

  it('shows a failure to load', async () => {
    renderApp({
      path: '/settings/credit',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /credit-rules': () => json({ message: 'Database down' }, 503),
      },
    });
    expect(await screen.findByText('Could not load the credit rules')).toBeVisible();
  });
});
