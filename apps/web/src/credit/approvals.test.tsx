import { SYSTEM_ROLES } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  BILL_APPROVAL,
  RELEASE_APPROVAL,
  SALE_APPROVAL,
  SALE_CHECK,
  approvalDetail,
} from '../test-support/approval-fixtures.js';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import { APPROVALS_PAGE_SIZE } from './CreditApprovalsPage.js';

const SALES = profile(SYSTEM_ROLES.find((role) => role.key === 'sales_executive')?.permissions, {
  role: { key: 'sales_executive', name: 'Sales Executive' },
  memberId: 'm2',
});
const location = () => screen.getByTestId('location').textContent;
const dialog = () => screen.getByRole('dialog');

describe('CreditApprovalsPage', { timeout: 30_000 }, () => {
  it('lists what waits for me, decides it, and shows other statuses on request', async () => {
    const decisions: unknown[] = [];
    const { user, requests } = renderApp({
      path: '/credit/approvals',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /credit-approvals': (request) =>
          request.query.get('mine') === 'true'
            ? json({ items: [SALE_APPROVAL, RELEASE_APPROVAL], total: 2 })
            : json({ items: [BILL_APPROVAL], total: 1 }),
        'POST /credit-approvals/:id/approve': (request) => {
          decisions.push(['approve', request.path, request.body]);
          return json(SALE_APPROVAL);
        },
        'POST /credit-approvals/:id/reject': (request) => {
          decisions.push(['reject', request.path, request.body]);
          return json(SALE_APPROVAL);
        },
      },
    });
    const table = await screen.findByRole('table', { name: 'Credit approvals' });
    expect(requests.at(-1)?.query.toString()).toBe('mine=true&limit=50&offset=0');
    const [, sale, release] = within(table).getAllByRole('row');
    expect(within(found(sale)).getByRole('link', { name: 'AP-000001' })).toHaveAttribute(
      'href',
      `/credit/approvals/${SALE_APPROVAL.id}`,
    );
    expect(within(found(sale)).getByRole('link', { name: 'Order SO-000017' })).toHaveAttribute(
      'href',
      '/sales-orders/order-1',
    );
    expect(sale).toHaveTextContent(
      'Apex BuildersSite: Jubilee Hills villaOrder SO-000017₹15,000.00the ownerVikram Sales8 Oct 2026Waiting',
    );
    expect(release).toHaveTextContent('Release the credit hold—An approver');

    // Approving a release can waive overdue days; rejecting needs a reason.
    await user.click(screen.getByRole('button', { name: 'Approve AP-000002' }));
    await user.type(
      within(dialog()).getByLabelText('Waive overdue days until (optional)'),
      '2026-10-20',
    );
    await user.type(
      within(dialog()).getByRole('textbox', { name: 'Reason (optional)' }),
      'Paid half',
    );
    await user.click(within(dialog()).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved', { selector: 'strong' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Approve AP-000001' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(decisions).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'Reject AP-000001' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Reject' }));
    expect(
      await within(dialog()).findByText('Give a reason of at least 3 characters'),
    ).toBeVisible();
    await user.type(within(dialog()).getByRole('textbox', { name: 'Reason' }), 'Too much');
    await user.click(within(dialog()).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Rejected', { selector: 'strong' })).toBeVisible();
    expect(decisions).toEqual([
      [
        'approve',
        `/credit-approvals/${RELEASE_APPROVAL.id}/approve`,
        { reason: 'Paid half', waiveOverdueUntil: '2026-10-20' },
      ],
      ['approve', `/credit-approvals/${SALE_APPROVAL.id}/approve`, {}],
      ['reject', `/credit-approvals/${SALE_APPROVAL.id}/reject`, { reason: 'Too much' }],
    ]);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'Used');
    await waitFor(() => {
      expect(location()).toBe('/credit/approvals?status=used');
    });
    expect(await screen.findByRole('link', { name: 'Bill HYD/26-27/000009' })).toBeVisible();
    expect(requests.at(-1)?.query.toString()).toBe('status=used&mine=false&limit=50&offset=0');
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'All approvals');
    await waitFor(() => {
      expect(requests.at(-1)?.query.toString()).toBe('mine=false&limit=50&offset=0');
    });
  });

  it('pages, explains an empty list and shows a failure', async () => {
    let total = APPROVALS_PAGE_SIZE + 1;
    const first = renderApp({
      path: '/credit/approvals',
      routes: {
        'GET /auth/me': () => json(SALES),
        'GET /credit-approvals': (request) =>
          request.query.get('offset') === '0'
            ? json({
                items: [{ ...BILL_APPROVAL, subject: { ...BILL_APPROVAL.subject, number: null } }],
                total,
              })
            : json({ items: [], total: (total = 0) }),
      },
    });
    expect(await screen.findByRole('link', { name: 'Bill (not issued yet)' })).toBeVisible();
    await first.user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Nothing waiting for a decision')).toBeVisible();
    first.unmount();

    renderApp({
      path: '/credit/approvals',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /credit-approvals': () => json({ message: 'Database down' }, 503),
      },
    });
    expect(await screen.findByText('Could not load credit approvals')).toBeVisible();
  });
});

describe('CreditApprovalPage', { timeout: 30_000 }, () => {
  it('shows a waiting sale with where it stood and stands, for the owner to decide', async () => {
    renderApp({
      path: `/credit/approvals/${SALE_APPROVAL.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /credit-approvals/:id': () =>
          json(
            approvalDetail(SALE_APPROVAL, {
              ...SALE_CHECK,
              site: {
                siteAccountId: 'site-1',
                projectId: 'project-1',
                projectName: 'Jubilee Hills villa',
                status: 'active',
                limitPaise: 10_000_00,
                exposurePaise: 0,
                check: { ...SALE_CHECK.check, utilizationPercent: null } as never,
              },
            }),
          ),
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'AP-000001 · Credit approval', level: 1 }),
    ).toBeVisible();
    const details = screen.getByRole('region', { name: 'Details' });
    expect(details).toHaveTextContent('On credit₹15,000.00');
    expect(details).toHaveTextContent('Approved bythe owner');
    expect(details).toHaveTextContent('StoreHyderabad');
    expect(details).toHaveTextContent('SiteJubilee Hills villa');
    expect(screen.getByRole('region', { name: 'When it was asked' })).toHaveTextContent(
      'Owes after it₹33,000.00',
    );
    expect(screen.getByRole('region', { name: 'Where it stands now' })).toHaveTextContent(
      'Site limit used after it—',
    );
    expect(screen.getByRole('button', { name: 'Approve AP-000001' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeVisible();
  });

  it('lets the requester withdraw a waiting release, and shows a decided one', async () => {
    let cancels = 0;
    const first = renderApp({
      path: `/credit/approvals/${RELEASE_APPROVAL.id}`,
      routes: {
        'GET /auth/me': () => json(SALES),
        'GET /credit-approvals/:id': () =>
          json(approvalDetail({ ...RELEASE_APPROVAL, canDecide: false })),
        'POST /credit-approvals/:id/cancel': () => {
          cancels += 1;
          return cancels === 1
            ? json({ message: 'This approval is approved' }, 409)
            : json(RELEASE_APPROVAL);
        },
      },
    });
    await screen.findByRole('heading', { name: 'AP-000002 · Credit approval', level: 1 });
    expect(screen.getByRole('region', { name: 'Details' })).toHaveTextContent(
      'Approved byAn approver',
    );
    expect(screen.queryByRole('button', { name: 'Approve AP-000002' })).toBeNull();
    await first.user.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(await screen.findByText('This approval is approved')).toBeVisible();
    await first.user.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(await screen.findByText('Approval withdrawn')).toBeVisible();
    first.unmount();

    renderApp({
      path: `/credit/approvals/${BILL_APPROVAL.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /credit-approvals/:id': () =>
          json(
            approvalDetail({
              ...BILL_APPROVAL,
              checkAtRequest: null,
              decisionReason: null,
              waiveOverdueUntil: '2026-10-20',
            }),
          ),
      },
    });
    const details = await screen.findByRole('region', { name: 'Details' });
    expect(details).toHaveTextContent('Decided byAnil Kumar');
    expect(details).toHaveTextContent('Decision reason—');
    expect(details).toHaveTextContent('Overdue days waived until20 Oct 2026');
    expect(details).toHaveTextContent('Sale went ahead');
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'When it was asked' })).toBeNull();
  });

  it('shows an order that is no longer on credit with its position only', async () => {
    renderApp({
      path: `/credit/approvals/${SALE_APPROVAL.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /credit-approvals/:id': () =>
          json(
            approvalDetail(SALE_APPROVAL, {
              ...SALE_CHECK,
              required: false,
              check: null,
              approval: 'none',
            }),
          ),
      },
    });
    const now = await screen.findByRole('region', { name: 'Where it stands now' });
    expect(now).toHaveTextContent('Owed now₹18,000.00');
    expect(now).not.toHaveTextContent('Owes after it');
  });

  it('shows a failure', async () => {
    renderApp({
      path: `/credit/approvals/${SALE_APPROVAL.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /credit-approvals/:id': () => json({ message: 'Not found' }, 404),
      },
    });
    expect(await screen.findByText('Could not load this credit approval')).toBeVisible();
  });
});
