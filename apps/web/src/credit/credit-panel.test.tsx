import { SYSTEM_ROLES } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CreditSummary } from '../api/credit.js';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import {
  CREDIT,
  CREDIT_REQUEST,
  NO_CREDIT,
  OVERVIEW,
  PARTY,
  loyaltyView,
} from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { readBalance, readRequest } from './CreditPanel.js';

const BRANCH_MANAGER = profile(
  SYSTEM_ROLES.find((role) => role.key === 'branch_manager')?.permissions,
  { role: { key: 'branch_manager', name: 'Branch Manager' }, allStores: false },
);

function renderCredit(
  credit: CreditSummary,
  routes: Record<string, FakeHandler> = {},
  member = OWNER,
) {
  let overviews = 0;
  const view = renderApp({
    path: `/parties/${PARTY.id}`,
    routes: {
      'GET /auth/me': () => json(member),
      'GET /parties/:id/overview': () => {
        overviews += 1;
        return json({ ...OVERVIEW, credit, loyalty: null });
      },
      'GET /parties/:id/loyalty': () => json(loyaltyView()),
      ...routes,
    },
  });
  return { ...view, overviews: () => overviews };
}

const panel = () => screen.getByRole('region', { name: 'Credit' });
const dialog = () => screen.getByRole('dialog');

describe('readRequest', () => {
  it('reads a limit in rupees and whole credit days', () => {
    expect(readRequest('1,00,000', ' 45 ')).toEqual({ limitPaise: 1_00_000_00, creditDays: 45 });
    expect(readRequest('abc', '30')).toBe('limit');
    expect(readRequest('0', '30')).toBe('limit');
    expect(readRequest('1000000000', '30')).toBe('limit');
    expect(readRequest('100', '366')).toBe('days');
    expect(readRequest('100', '1.5')).toBe('days');
  });
});

describe('readBalance', () => {
  it('reads what is owed in rupees and whole days overdue', () => {
    expect(readBalance('12,500.50', ' 10 ')).toEqual({
      manualExposurePaise: 12_500_50,
      overdueDays: 10,
    });
    expect(readBalance('0', '0')).toEqual({ manualExposurePaise: 0, overdueDays: 0 });
    expect(readBalance('a lot', '0')).toBe('owed');
    expect(readBalance('-5', '0')).toBe('owed');
    expect(readBalance('100000000000.01', '0')).toBe('owed');
    expect(readBalance('100', '10001')).toBe('overdue');
    expect(readBalance('100', '-1')).toBe('overdue');
  });
});

describe('CreditPanel', { timeout: 30_000 }, () => {
  it('shows where the customer stands and what the next sale needs', async () => {
    renderCredit(CREDIT);
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
    const credit = panel();
    expect(within(credit).getByText('Active')).toBeVisible();
    expect(within(credit).getByText('₹50,000.00')).toBeVisible();
    expect(within(credit).getByText('30 days')).toBeVisible();
    expect(within(credit).getByText('₹40,000.00')).toBeVisible();
    expect(within(credit).getByText('20%')).toBeVisible();
    expect(within(credit).getByText('Medium')).toBeVisible();
    expect(within(credit).getByText('Allowed')).toBeVisible();
    expect(within(credit).queryByRole('button', { name: 'Release hold' })).toBeNull();
  });

  it('asks for a limit, checking the amount and days first', async () => {
    let body: unknown;
    const { user, overviews } = renderCredit(CREDIT, {
      'POST /credit-requests': (request) => {
        body = request.body;
        return json(CREDIT_REQUEST, 201);
      },
    });
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
    await user.click(within(panel()).getByRole('button', { name: 'Request credit' }));
    expect(dialog()).toHaveTextContent('Owners and admins are told and decide.');
    const limit = within(dialog()).getByRole('textbox', { name: 'Limit (₹)' });
    const days = within(dialog()).getByRole('textbox', { name: 'Days to pay' });
    expect(limit).toHaveValue('50000.00');
    expect(days).toHaveValue('30');

    await user.clear(limit);
    await user.type(limit, 'lots');
    await user.click(within(dialog()).getByRole('button', { name: 'Send for approval' }));
    expect(
      within(dialog()).getByText('Enter an amount in rupees, above zero and up to ₹10 crore'),
    ).toBeVisible();
    await user.clear(limit);
    await user.type(limit, '100000');
    await user.clear(days);
    await user.type(days, '400');
    await user.click(within(dialog()).getByRole('button', { name: 'Send for approval' }));
    expect(within(dialog()).getByText('Enter 0 to 365 days')).toBeVisible();
    await user.clear(days);
    await user.type(days, '45');
    await user.type(
      within(dialog()).getByRole('textbox', { name: 'Why this customer should get it' }),
      'Big order coming',
    );
    await user.click(within(dialog()).getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findByText('Credit request sent for approval')).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(body).toEqual({
      partyId: PARTY.id,
      limitPaise: 1_00_000_00,
      creditDays: 45,
      note: 'Big order coming',
    });
    await waitFor(() => {
      expect(overviews()).toBe(2);
    });
  });

  it('starts a first request empty, leaves out an empty note, and shows the API’s refusal', async () => {
    let calls = 0;
    let body: unknown;
    const { user } = renderCredit(
      NO_CREDIT,
      {
        'POST /credit-requests': (request) => {
          calls += 1;
          body = request.body;
          return calls === 1
            ? json({ message: 'CR-000009 is already waiting for approval' }, 409)
            : json(CREDIT_REQUEST, 201);
        },
      },
      BRANCH_MANAGER,
    );
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
    const credit = panel();
    expect(within(credit).getByText('No credit')).toBeVisible();
    expect(within(credit).getByText('Blocked: No credit limit')).toBeVisible();
    expect(within(credit).getByText('—')).toBeVisible();
    expect(within(credit).queryByRole('button', { name: 'Put on hold' })).toBeNull();
    await user.click(within(credit).getByRole('button', { name: 'Request credit' }));
    const limit = within(dialog()).getByRole('textbox', { name: 'Limit (₹)' });
    expect(limit).toHaveValue('');
    await user.type(limit, '25000');
    await user.click(within(dialog()).getByRole('button', { name: 'Send for approval' }));
    expect(
      await within(dialog()).findByText('CR-000009 is already waiting for approval'),
    ).toBeVisible();
    await user.click(within(dialog()).getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findByText('Credit request sent for approval')).toBeVisible();
    expect(body).toEqual({ partyId: PARTY.id, limitPaise: 25_000_00, creditDays: 0 });
  });

  it('records what the customer owes, how late and the risk, by hand until billing', async () => {
    let body: unknown;
    const { user, overviews } = renderCredit(
      CREDIT,
      {
        'PATCH /parties/:id/credit': (request) => {
          body = request.body;
          return json({});
        },
      },
      BRANCH_MANAGER,
    );
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
    await user.click(within(panel()).getByRole('button', { name: 'Update balance' }));
    expect(dialog()).toHaveTextContent('Entered by hand until billing works it out from invoices.');
    const owed = within(dialog()).getByRole('textbox', { name: 'Owes now (₹)' });
    const overdue = within(dialog()).getByRole('textbox', { name: 'Days overdue' });
    const risk = within(dialog()).getByRole('combobox', { name: 'Risk' });
    expect(owed).toHaveValue('10000.00');
    expect(overdue).toHaveValue('0');
    expect(risk).toHaveValue('medium');
    await user.clear(owed);
    await user.type(owed, 'unknown');
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(within(dialog()).getByText('Enter an amount in rupees, zero or more')).toBeVisible();
    await user.clear(owed);
    await user.type(owed, '62000');
    await user.clear(overdue);
    await user.type(overdue, 'ten');
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(within(dialog()).getByText('Enter 0 to 10,000 days')).toBeVisible();
    await user.clear(overdue);
    await user.type(overdue, '12');
    await user.selectOptions(risk, 'high');
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Balance updated')).toBeVisible();
    expect(body).toEqual({ risk: 'high', manualExposurePaise: 62_000_00, overdueDays: 12 });
    await waitFor(() => {
      expect(overviews()).toBe(2);
    });
  });

  it('puts credit on hold with a reason', async () => {
    let body: unknown;
    const { user } = renderCredit(
      CREDIT,
      {
        'POST /parties/:id/credit/hold': (request) => {
          body = request.body;
          return json({});
        },
      },
      BRANCH_MANAGER,
    );
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
    await user.click(within(panel()).getByRole('button', { name: 'Put on hold' }));
    const reason = within(dialog()).getByRole('textbox', { name: 'Reason' });
    await user.type(reason, 'no');
    await user.click(within(dialog()).getByRole('button', { name: 'Put on hold' }));
    expect(within(dialog()).getByText('Give a reason of at least 3 characters')).toBeVisible();
    await user.type(reason, 't paying');
    await user.click(within(dialog()).getByRole('button', { name: 'Put on hold' }));
    expect(await screen.findByText('Credit is on hold')).toBeVisible();
    expect(body).toEqual({ reason: 'not paying' });
    await user.click(within(panel()).getByRole('button', { name: 'Put on hold' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lets approvers release a hold and decide the waiting request', async () => {
    let releases = 0;
    const held: CreditSummary = {
      ...CREDIT,
      status: 'on_hold',
      check: { ...CREDIT.check, decision: 'blocked', blockedBecause: 'on_hold' },
      pendingRequest: {
        id: CREDIT_REQUEST.id,
        number: 'CR-000001',
        limitPaise: 1_00_000_00,
        creditDays: 45,
      },
    };
    const decisions: unknown[] = [];
    const releaseBodies: unknown[] = [];
    const { user } = renderCredit(held, {
      'POST /parties/:id/credit/release': (request) => {
        releases += 1;
        releaseBodies.push(request.body);
        return releases === 1 ? json({ message: 'This party is not on hold' }, 409) : json({});
      },
      'POST /credit-requests/:id/approve': (request) => {
        decisions.push(['approve', request.body]);
        return json(CREDIT_REQUEST);
      },
      'POST /credit-requests/:id/reject': (request) => {
        decisions.push(['reject', request.body]);
        return json(CREDIT_REQUEST);
      },
    });
    await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
    const credit = panel();
    expect(within(credit).getByText('Blocked: Credit is on hold')).toBeVisible();
    expect(
      within(credit).getByRole('link', {
        name: 'Request CR-000001 is waiting for approval: ₹1,00,000.00 for 45 days',
      }),
    ).toHaveAttribute('href', `/credit-requests/${CREDIT_REQUEST.id}`);
    expect(within(credit).queryByRole('button', { name: 'Request credit' })).toBeNull();

    // Releasing asks for an optional reason and how long overdue days are waived.
    await user.click(within(credit).getByRole('button', { name: 'Release hold' }));
    expect(
      within(dialog()).getByRole('heading', { name: 'Release the credit hold' }),
    ).toBeVisible();
    await user.click(within(dialog()).getByRole('button', { name: 'Release hold' }));
    expect(await within(dialog()).findByText('This party is not on hold')).toBeVisible();
    await user.type(within(dialog()).getByRole('textbox', { name: 'Reason (optional)' }), 'Paid');
    await user.type(
      within(dialog()).getByLabelText('Waive overdue days until (optional)'),
      '2026-10-20',
    );
    await user.click(within(dialog()).getByRole('button', { name: 'Release hold' }));
    expect(await screen.findByText('Credit released')).toBeVisible();
    expect(releaseBodies).toEqual([{}, { reason: 'Paid', waiveOverdueUntil: '2026-10-20' }]);

    await user.click(within(credit).getByRole('button', { name: 'Approve CR-000001' }));
    expect(
      within(dialog()).getByRole('heading', { name: 'Approve request CR-000001' }),
    ).toBeVisible();
    await user.click(within(dialog()).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Credit approved')).toBeVisible();

    await user.click(within(credit).getByRole('button', { name: 'Approve CR-000001' }));
    await user.type(
      within(dialog()).getByRole('textbox', { name: 'Note (optional)' }),
      'Good payer',
    );
    await user.click(within(dialog()).getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(decisions).toHaveLength(2);
    });

    await user.click(within(credit).getByRole('button', { name: 'Reject CR-000001' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Reject' }));
    expect(within(dialog()).getByText('Give a reason of at least 3 characters')).toBeVisible();
    await user.type(within(dialog()).getByRole('textbox', { name: 'Reason' }), 'Too risky');
    await user.click(within(dialog()).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Request rejected')).toBeVisible();
    expect(decisions).toEqual([
      ['approve', {}],
      ['approve', { note: 'Good payer' }],
      ['reject', { reason: 'Too risky' }],
    ]);
  });
});
