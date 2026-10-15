import { SYSTEM_ROLES, type CreditApprovalRefusal } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors.js';
import { json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { creditRefusalOf, creditStep } from './CreditCheckDialog.js';
import { AMP, CASHIER_POS, ISSUED, KPH } from './test-support/pos-fixtures.js';
import { renderPos, scanBox } from './test-support/pos-render.js';

beforeEach(() => {
  vi.spyOn(window, 'print').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const MANAGER_POS = profile(
  SYSTEM_ROLES.find((role) => role.key === 'branch_manager')?.permissions,
  {
    role: { key: 'branch_manager', name: 'Branch Manager' },
    allStores: false,
    storeIds: [AMP.id, KPH.id],
  },
);

/** §6.3 at the counter: ₹30,000 limit, ₹18,000 owed, this bill takes it to 83 % or more. */
function refusal(
  code: CreditApprovalRefusal['code'],
  approval: 'manager' | 'owner' | 'blocked' = 'manager',
  extra: Partial<CreditApprovalRefusal> = {},
): CreditApprovalRefusal {
  return {
    statusCode: 409,
    code,
    message: 'Refused',
    credit: {
      required: true,
      exposureSource: 'ledger',
      position: {
        status: 'active',
        limitPaise: 30_000_00,
        exposurePaise: 18_000_00,
        overdueDays: 0,
      },
      check: {
        decision: approval === 'blocked' ? 'allowed' : `${approval}_approval`,
        blockedBecause: null,
        projectedExposurePaise: 25_000_00,
        availablePaise: 5_000_00,
        utilizationPercent: 83.33,
      },
      site: null,
      approval,
    },
    approval: null,
    ...extra,
  };
}

/** A bill of one 20 l pack, ready to issue with no ways to pay set up (so "Issue bill" is one click). */
async function billRefused(
  answer: CreditApprovalRefusal,
  routes: Record<string, FakeHandler> = {},
  member = CASHIER_POS,
) {
  let issues = 0;
  const view = renderPos(
    {
      'GET /payment-modes': () => json([]),
      // Refused once; issued when tried again with an approval.
      'POST /invoices/:id/issue': () => {
        issues += 1;
        return issues === 1 ? json(answer, 409) : json(ISSUED);
      },
      ...routes,
    },
    member,
  );
  const box = await scanBox();
  await view.user.type(box, 'APX-20L{Enter}');
  await screen.findByRole('list', { name: 'Bill' });
  await waitFor(() => {
    expect(screen.getByText('Bill saved')).toBeInTheDocument();
  });
  await view.user.keyboard('{F8}');
  const pay = await screen.findByRole('dialog', { name: 'Payment' });
  await view.user.click(within(pay).getByRole('button', { name: 'Issue bill' }));
  const dialog = await screen.findByRole('dialog', { name: 'Credit check' });
  return { ...view, dialog };
}

describe('creditRefusalOf and creditStep', () => {
  it('reads a credit refusal from an API error, and nothing else', () => {
    const body = refusal('credit_approval_required');
    expect(creditRefusalOf(new ApiError(409, 'Refused', [], [], body as never))).toEqual(body);
    expect(
      creditRefusalOf(new ApiError(409, 'No stock', [], [], { message: 'No stock' })),
    ).toBeNull();
    expect(creditRefusalOf(new Error('offline'))).toBeNull();
  });

  it('decides what the counter can do', () => {
    expect(creditStep(refusal('credit_blocked', 'blocked'), true)).toBe('blocked');
    expect(creditStep(refusal('credit_approval_pending'), true)).toBe('pending');
    expect(creditStep(refusal('credit_approval_required'), true)).toBe('approve');
    expect(creditStep(refusal('credit_approval_stale'), false)).toBe('ask');
  });
});

describe('PosPage: a bill on credit past the rules', () => {
  it('lets a cashier ask for approval and holds the bill meanwhile', async () => {
    const { user, dialog, requests } = await billRefused(refusal('credit_approval_required'), {
      'POST /credit-approvals': () =>
        json({ id: 'ap-1', number: 'AP-000007', kind: 'sale', status: 'pending' }, 201),
    });
    expect(dialog).toHaveTextContent(
      'This bill goes past the credit rules: a manager must approve. The bill is held meanwhile.',
    );
    expect(dialog).toHaveTextContent('Owes after it₹25,000.00');
    await user.click(within(dialog).getByRole('button', { name: 'Ask for approval' }));
    expect(await within(dialog).findByText('Give a reason of at least 3 characters')).toBeVisible();
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why this sale/ }),
      'Regular contractor',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Ask for approval' }));
    expect(
      await screen.findByText(
        'Asked for approval (AP-000007); the bill is held until it is decided',
      ),
    ).toBeVisible();
    expect(requests.find((request) => request.path === '/credit-approvals')?.body).toEqual({
      invoiceId: 'draft-1',
      amountPaise: 7_000_00,
      reason: 'Regular contractor',
    });
    // The next customer's bill starts empty.
    expect(screen.queryByRole('list', { name: 'Bill' })).toBeNull();
  });

  it('lets a manager approve at the counter and issue at once', async () => {
    const { user, dialog, requests } = await billRefused(
      refusal('credit_approval_stale'),
      {},
      MANAGER_POS,
    );
    expect(dialog).toHaveTextContent('As a manager, you can approve it now.');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Known for years');
    await user.click(within(dialog).getByRole('button', { name: 'Approve and issue' }));
    expect(await screen.findByRole('dialog', { name: /issued/ })).toBeVisible();
    const issues = requests.filter((request) => request.path === '/invoices/draft-1/issue');
    expect(issues.at(-1)?.body).toEqual({ creditOverride: { reason: 'Known for years' } });
  });

  it('holds a bill already waiting for its approval, or closes the prompt', async () => {
    const waiting = refusal('credit_approval_pending', 'owner', {
      approval: {
        id: 'ap-2',
        number: 'AP-000002',
        status: 'pending',
        level: 'owner',
        requestedBy: { memberId: 'm1', name: 'Ravi' },
        createdAt: '2026-10-08T06:00:00.000Z',
      },
    });
    const { user, dialog } = await billRefused(waiting);
    expect(dialog).toHaveTextContent('AP-000002 is waiting for the owner to approve');
    await user.click(within(dialog).getByRole('button', { name: 'Hold the bill' }));
    expect(await screen.findByText('Bill held')).toBeVisible();
  });

  it('sends a blocked customer back to paying, naming the site that blocks it', async () => {
    const blocked = refusal('credit_blocked', 'blocked', {});
    const onSite: CreditApprovalRefusal = {
      ...blocked,
      credit: {
        ...blocked.credit,
        site: {
          siteAccountId: 'site-1',
          projectId: 'project-1',
          projectName: 'Jubilee Hills villa',
          status: 'on_hold',
          limitPaise: 10_000_00,
          exposurePaise: 0,
          check: {
            decision: 'blocked',
            blockedBecause: 'on_hold',
            projectedExposurePaise: 7_000_00,
            availablePaise: 3_000_00,
            utilizationPercent: 70,
          },
        },
      },
    };
    const { user, dialog } = await billRefused(onSite);
    expect(dialog).toHaveTextContent('Credit is blocked: Credit is on hold.');
    expect(dialog).toHaveTextContent('SiteJubilee Hills villa');
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Take payment instead' }));
    expect(await screen.findByRole('dialog', { name: 'Payment' })).toBeVisible();
  });

  it('closes without doing anything', async () => {
    const { user, dialog } = await billRefused(refusal('credit_approval_required', 'owner'));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Credit check' })).toBeNull();
    });
    expect(screen.getByRole('list', { name: 'Bill' })).toBeVisible();
  });
});
