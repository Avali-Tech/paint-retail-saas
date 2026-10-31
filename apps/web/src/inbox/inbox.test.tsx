import type { InboxGroup, InboxItem, InboxView } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CASHIER, OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { STORES } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { inboxBadge } from './inbox-count.js';
import { KIND_PATHS } from './InboxPage.js';

const NOW = new Date().toISOString();

const item = (
  overrides: Partial<InboxItem> & Pick<InboxItem, 'kind' | 'id' | 'step'>,
): InboxItem => ({
  reference: null,
  title: 'Something',
  requestedBy: null,
  store: null,
  amountPaise: null,
  since: null,
  due: null,
  quantity: null,
  priority: 'normal',
  link: '/somewhere',
  actions: [],
  ...overrides,
});

const action = (key: 'approve' | 'reject' | 'acknowledge' | 'complete') => ({
  key,
  endpoint: '/x',
  input: 'none' as const,
});

const APPROVAL = item({
  kind: 'credit_approval',
  id: 'approval-1',
  step: 'approve_sale',
  reference: 'AP-000012',
  title: 'Deccan Contractors',
  requestedBy: 'Sita Rao',
  store: { id: 'store-hyd', name: 'Hyderabad' },
  amountPaise: 25_000_00,
  since: NOW,
  priority: 'high',
  link: '/credit/approvals/approval-1',
  actions: [action('approve'), action('reject')],
});
const RELEASE = item({
  kind: 'credit_approval',
  id: 'approval-2',
  step: 'approve_release',
  reference: 'AP-000013',
  title: 'Wide Traders',
  actions: [action('approve'), action('reject')],
});
const REQUEST = item({
  kind: 'credit_request',
  id: 'request-1',
  step: 'decide_request',
  reference: 'CR-000004',
  title: 'Suresh',
  amountPaise: 50_000_00,
  actions: [action('approve'), action('reject')],
});
const TO_APPROVE = item({
  kind: 'transfer',
  id: 'transfer-1',
  step: 'approve_transfer',
  reference: 'TR-000001',
  title: 'Hyderabad → Pune',
  actions: [action('approve'), action('reject')],
});
const TO_RECEIVE = item({
  kind: 'transfer',
  id: 'transfer-2',
  step: 'receive_transfer',
  reference: 'TR-000002',
  title: 'Pune → Hyderabad',
  link: '/transfers/transfer-2',
});
const COUNT = item({
  kind: 'stock_count',
  id: 'count-1',
  step: 'approve_count',
  title: 'SC-000003',
  link: '/stock-counts/count-1',
});
const ESCALATION = item({
  kind: 'escalation',
  id: 'escalation-1',
  step: 'acknowledge_escalation',
  title: 'Apex Builders',
  amountPaise: 10_000_00,
  since: '2026-10-29',
  due: '2026-10-28',
  actions: [action('acknowledge')],
});
const FOLLOW_UP = item({
  kind: 'follow_up',
  id: 'activity-1',
  step: 'follow_up_overdue',
  reference: 'Suresh',
  title: 'Call about the shade card',
  due: NOW,
  priority: 'high',
  actions: [action('complete')],
});
const LOW = item({
  kind: 'low_stock',
  id: 'store-hyd:variant-1',
  step: 'out_of_stock',
  reference: 'APX-1L',
  title: 'Asian Paints Apex Ultima 1 l',
  quantity: { available: 0, reorderLevel: 5, suggested: 20, unit: 'l' },
  link: '/stock/low?store=store-hyd',
});

const group = (items: InboxItem[], total = items.length): InboxGroup => ({
  kind: items[0]?.kind ?? 'follow_up',
  total,
  items,
});

const VIEW: InboxView = {
  kinds: [
    'credit_approval',
    'credit_request',
    'transfer',
    'stock_count',
    'escalation',
    'follow_up',
    'low_stock',
  ],
  groups: [
    group([APPROVAL, RELEASE]),
    group([REQUEST]),
    group([TO_APPROVE, TO_RECEIVE], 25),
    group([COUNT]),
    group([ESCALATION]),
    group([FOLLOW_UP]),
    group([LOW]),
  ],
  total: 32,
};

const routes = (view: InboxView = VIEW, extra: Record<string, FakeHandler> = {}) => ({
  'GET /auth/me': () => json(OWNER),
  'GET /inbox': () => json(view),
  'GET /inbox/count': () => json({ total: view.total }),
  'GET /stores': () => json(STORES),
  ...extra,
});

describe('the inbox badge', () => {
  it('shows what waits on Home, in the side bar and the phone bar, and on the Inbox tab', async () => {
    renderApp({ path: '/inbox', routes: routes() });
    const menus = await screen.findAllByRole('navigation', { name: 'Main' });
    for (const menu of menus) {
      expect(
        await within(menu).findByRole('link', { name: 'Home, 32 waiting for you' }),
      ).toBeInTheDocument();
    }
    expect(menus).toHaveLength(2);
    expect(
      within(screen.getByRole('navigation', { name: 'Home' })).getByRole('link', {
        name: 'Inbox, 32 waiting for you',
      }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('has no badge when nothing waits, or the count cannot be loaded', async () => {
    renderApp({
      path: '/inbox',
      routes: routes(
        { kinds: ['follow_up'], groups: [], total: 0 },
        {
          'GET /inbox/count': () => json({ message: 'Down' }, 500),
        },
      ),
    });
    expect(await screen.findByText('Nothing waiting for you')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Home' }).length).toBeGreaterThan(0);
  });

  it('caps what the badge shows', () => {
    expect(inboxBadge(7)).toBe('7');
    expect(inboxBadge(99)).toBe('99');
    expect(inboxBadge(150)).toBe('99+');
  });
});

describe('the inbox page', () => {
  it('groups what waits by kind, with the facts of each item', async () => {
    renderApp({ path: '/inbox', routes: routes() });
    expect(await screen.findByRole('heading', { name: 'Needs action', level: 1 })).toBeVisible();
    const approvals = await screen.findByRole('region', { name: 'Credit approvals (2)' });
    expect(within(approvals).getByRole('link', { name: 'Deccan Contractors' })).toHaveAttribute(
      'href',
      '/credit/approvals/approval-1',
    );
    expect(
      within(approvals).getByText('Sale on credit to approve · AP-000012 · Hyderabad · ₹25,000.00'),
    ).toBeInTheDocument();
    expect(within(approvals).getByText(/^By Sita Rao · Raised/)).toBeInTheDocument();
    expect(within(approvals).getByText('Urgent')).toBeInTheDocument();
    // More than shown: a way to the whole queue.
    const transfers = screen.getByRole('region', { name: 'Transfers (25)' });
    expect(within(transfers).getByRole('link', { name: 'See all 25' })).toHaveAttribute(
      'href',
      '/transfers',
    );
    expect(within(transfers).getByRole('link', { name: 'Receive: TR-000002' })).toHaveAttribute(
      'href',
      '/transfers/transfer-2',
    );
    const counts = screen.getByRole('region', { name: 'Stock counts (1)' });
    expect(within(counts).getByRole('link', { name: 'Review: SC-000003' })).toBeInTheDocument();
    const promises = screen.getByRole('region', { name: 'Broken promises (1)' });
    expect(within(promises).getByText(/Due 28 Oct 2026/)).toBeInTheDocument();
    const low = screen.getByRole('region', { name: 'Low stock (1)' });
    expect(
      within(low).getByText('Out of stock · APX-1L · 0 l available, reorder at 5'),
    ).toBeInTheDocument();
    expect(within(low).getByRole('link', { name: 'Reorder: APX-1L' })).toHaveAttribute(
      'href',
      '/stock/low?store=store-hyd',
    );
    expect(KIND_PATHS.low_stock).toBe('/stock/low');
  });

  it('filters by kind and store', async () => {
    const { user, requests } = renderApp({ path: '/inbox', routes: routes() });
    await screen.findByRole('region', { name: 'Credit approvals (2)' });
    await user.selectOptions(screen.getByLabelText('Show'), 'Transfers');
    await user.selectOptions(screen.getByLabelText('Store'), 'HYD · Hyderabad');
    await waitFor(() => {
      const last = requests.filter((request) => request.path === '/inbox').at(-1);
      expect(Object.fromEntries(last?.query ?? [])).toEqual({
        kind: 'transfer',
        storeId: 'store-hyd',
      });
    });
    await user.selectOptions(screen.getByLabelText('Show'), 'Everything');
    await waitFor(() => {
      const last = requests.filter((request) => request.path === '/inbox').at(-1);
      expect(Object.fromEntries(last?.query ?? [])).toEqual({ storeId: 'store-hyd' });
    });
  });

  it('says when nothing waits, and when the inbox cannot load', async () => {
    renderApp({
      path: '/inbox',
      routes: {
        'GET /auth/me': () => json(CASHIER),
        'GET /inbox': () => json({ message: 'Down' }, 500),
        'GET /stores': () => json(STORES),
      },
    });
    expect(await screen.findByText('Could not load your inbox')).toBeInTheDocument();
  });
});

describe('acting from the inbox', () => {
  const countCalls = (requests: { path: string }[]) =>
    requests.filter((request) => request.path === '/inbox/count').length;

  it('approves a credit approval and a credit request in their dialogs', async () => {
    const posts: [string, unknown][] = [];
    const record: FakeHandler = (request) => {
      posts.push([request.path, request.body]);
      return json({});
    };
    const { user, requests } = renderApp({
      path: '/inbox',
      routes: routes(VIEW, {
        'POST /credit-approvals/:id/approve': record,
        'POST /credit-requests/:id/reject': record,
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Approve AP-000012' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reject CR-000004' }));
    await user.type(within(screen.getByRole('dialog')).getByRole('textbox'), 'Too high');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(posts).toEqual([
        ['/credit-approvals/approval-1/approve', {}],
        ['/credit-requests/request-1/reject', { reason: 'Too high' }],
      ]);
    });
    // The badge's count loads again after each.
    await waitFor(() => {
      expect(countCalls(requests)).toBeGreaterThanOrEqual(3);
    });
    // A release's approval asks until when overdue days are waived.
    await user.click(screen.getByRole('button', { name: 'Approve AP-000013' }));
    expect(within(screen.getByRole('dialog')).getByLabelText(/Waive overdue/)).toBeVisible();
  });

  it('approves a transfer at once, or rejects it with a reason', async () => {
    const posts: [string, unknown][] = [];
    let fail = false;
    const { user } = renderApp({
      path: '/inbox',
      routes: routes(VIEW, {
        'POST /transfers/:id/approve': (request) => {
          posts.push([request.path, request.body]);
          return fail
            ? json({ message: 'Someone else just changed this transfer' }, 409)
            : json({});
        },
        'POST /transfers/:id/reject': (request) => {
          posts.push([request.path, request.body]);
          return json({});
        },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Approve transfer TR-000001' }));
    expect(await screen.findByText('Transfer approved')).toBeInTheDocument();
    fail = true;
    await user.click(screen.getByRole('button', { name: 'Approve transfer TR-000001' }));
    expect(await screen.findByText('Someone else just changed this transfer')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reject transfer TR-000001' }));
    await user.type(within(screen.getByRole('dialog')).getByRole('textbox'), 'Not needed');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Transfer rejected')).toBeInTheDocument();
    expect(posts).toEqual([
      ['/transfers/transfer-1/approve', {}],
      ['/transfers/transfer-1/approve', {}],
      ['/transfers/transfer-1/reject', { reason: 'Not needed' }],
    ]);
  });

  it('acknowledges a broken promise and marks a follow-up done', async () => {
    const posts: [string, unknown][] = [];
    const { user } = renderApp({
      path: '/inbox',
      routes: routes(VIEW, {
        'POST /collections/escalations/:id/acknowledge': (request) => {
          posts.push([request.path, request.body]);
          return { status: 204 };
        },
        'POST /activities/:id/complete': (request) => {
          posts.push([request.path, request.body]);
          return json({ completed: {}, next: null });
        },
      }),
    });
    await user.click(
      await screen.findByRole('button', {
        name: 'Acknowledge the broken promise of Apex Builders',
      }),
    );
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Acknowledge' }),
    );
    expect(await screen.findByText('Escalation acknowledged')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark “Call about the shade card” done' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Mark done' }));
    expect(await screen.findByText('Follow-up done')).toBeInTheDocument();
    expect(posts).toEqual([
      ['/collections/escalations/escalation-1/acknowledge', {}],
      ['/activities/activity-1/complete', {}],
    ]);
  });

  it('offers no button where the member may not act from the inbox', async () => {
    const view: InboxView = {
      kinds: ['credit_approval', 'credit_request', 'transfer', 'follow_up'],
      groups: [
        group([{ ...APPROVAL, actions: [] }]),
        group([{ ...REQUEST, actions: [] }]),
        group([{ ...TO_APPROVE, actions: [] }]),
        group([{ ...FOLLOW_UP, actions: [] }]),
      ],
      total: 4,
    };
    renderApp({ path: '/inbox', routes: routes(view) });
    const main = await screen.findByRole('region', { name: 'Credit approvals (1)' });
    expect(within(main).queryByRole('button')).toBeNull();
    for (const name of ['Credit requests (1)', 'Transfers (1)', 'Follow-ups (1)']) {
      expect(within(screen.getByRole('region', { name })).queryByRole('button')).toBeNull();
    }
  });
});
