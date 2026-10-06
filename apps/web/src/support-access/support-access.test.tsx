import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_KEY } from '../auth/session-store.js';
import type { GrantView } from '../platform/platform-api.js';
import {
  CASHIER,
  DASHBOARD,
  GRANT,
  OWNER,
  json,
  profile,
  type FakeHandler,
} from '../test-support/fake-api.js';
import { ACTIVE_GRANT, grant } from '../test-support/platform-fixtures.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import { createI18n } from '../i18n/i18n.js';
import { grantLength } from './grants.js';
import { SUPPORT_TAB_KEY, isSupportTab, leaveSupportTab } from './support-tab.js';

const SUPPORT = profile(['stores:read', 'parties:read'], {
  role: { key: 'support', name: 'Platform support' },
});
const ENDED = grant({
  id: '00000000-0000-4000-8000-0000000000b3',
  status: 'ended',
  minutes: 45,
  approvedAt: '2026-09-01T05:00:00.000Z',
  expiresAt: '2026-09-01T05:45:00.000Z',
  endedAt: '2026-09-01T05:20:00.000Z',
});
const DECLINED = grant({
  id: '00000000-0000-4000-8000-0000000000b4',
  status: 'declined',
  declinedAt: '2026-09-03T05:00:00.000Z',
});

function renderTenant(path: string, me: unknown, routes: Record<string, FakeHandler>) {
  return renderApp({
    path,
    routes: { 'GET /auth/me': () => json(me), 'GET /dashboard': () => json(DASHBOARD), ...routes },
  });
}

describe('support access for owners and admins', () => {
  it('approves, declines and ends platform support’s access', async () => {
    let grants: GrantView[] = [
      grant(),
      grant({ id: 'second', reason: 'Login issue' }),
      ACTIVE_GRANT,
      ENDED,
    ];
    const decide =
      (change: (found: GrantView) => GrantView): FakeHandler =>
      (request) => {
        const id = request.path.split('/')[2];
        const found = grants.find((item) => item.id === id);
        if (found === undefined) return json({ message: 'Support request not found' }, 404);
        const next = change(found);
        grants = grants.map((item) => (item.id === id ? next : item));
        return json(next);
      };
    const { user, requests } = renderTenant('/settings/support', OWNER, {
      'GET /support-requests': () => json(grants),
      'POST /support-requests/:id/approve': decide((found) => ({
        ...found,
        status: 'active',
        approvedAt: '2026-10-01T05:00:00.000Z',
        expiresAt: '2026-10-01T06:00:00.000Z',
      })),
      'POST /support-requests/:id/decline': (request) =>
        request.path.includes('second')
          ? decide((found) => ({ ...found, status: 'declined' }))(request)
          : json({ message: 'This support request is active' }, 409),
      'POST /support-requests/:id/end': decide((found) => ({ ...found, status: 'ended' })),
    });
    expect(await screen.findByRole('heading', { name: 'Support access', level: 1 })).toBeVisible();
    const waiting = screen.getByRole('region', { name: 'Waiting for your decision' });
    const items = within(waiting).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Asha Operator asks for 1 hour of read-only access');
    expect(items[0]).toHaveTextContent('Stock report looks wrong');
    expect(items[0]).toHaveTextContent('Asked 1 Oct 2026, 10:00 am');
    const now = screen.getByRole('region', { name: 'Access now' });
    expect(now).toHaveTextContent('Until 1 Oct 2026, 11:30 am');
    const history = screen.getByRole('table', { name: 'Earlier support access requests' });
    expect(history).toHaveTextContent('45 minutes');
    expect(history).toHaveTextContent('Ended');

    await user.click(within(found(items[0])).getByRole('button', { name: 'Approve' }));
    expect(
      await screen.findByText('Approved. Support can look in until 1 Oct 2026, 11:30 am.'),
    ).toBeVisible();
    await waitFor(() => {
      expect(within(waiting).getAllByRole('listitem')).toHaveLength(1);
    });
    await user.click(within(waiting).getByRole('button', { name: 'Decline' }));
    expect(await screen.findByText('Request declined')).toBeVisible();
    expect(await within(waiting).findByText('No requests are waiting')).toBeVisible();

    const ends = within(now).getAllByRole('button', { name: 'End access now' });
    expect(ends).toHaveLength(2);
    await user.click(found(ends[0]));
    expect(await screen.findByText('Support access ended')).toBeVisible();
    expect(requests.filter((request) => request.method === 'POST').map((r) => r.path)).toEqual([
      `/support-requests/${grant().id}/approve`,
      '/support-requests/second/decline',
      `/support-requests/${grant().id}/end`,
    ]);
  });

  it('shows the API’s refusal', async () => {
    const { user } = renderTenant('/settings/support', OWNER, {
      'GET /support-requests': () => json([grant()]),
      'POST /support-requests/:id/decline': () =>
        json({ message: 'This support request is active' }, 409),
    });
    await user.click(await screen.findByRole('button', { name: 'Decline' }));
    expect(await screen.findByText('This support request is active')).toBeVisible();
  });

  it('says when nothing is waiting, running or in the past', async () => {
    renderTenant('/settings/support', OWNER, { 'GET /support-requests': () => json([]) });
    expect(await screen.findByText('No requests are waiting')).toBeVisible();
    expect(screen.getByText('Support cannot see your business right now')).toBeVisible();
    expect(screen.getByText('No earlier requests')).toBeVisible();
  });

  it('is only for members who manage the business', async () => {
    const { requests } = renderTenant('/settings/support', CASHIER, {});
    expect(await screen.findByText('No access')).toBeVisible();
    expect(requests.some((request) => request.path === '/support-requests')).toBe(false);
  });
});

describe('one support access request', () => {
  it('shows what support looked at, and keeps checking while access runs', async () => {
    const { user } = renderTenant(`/settings/support/${ACTIVE_GRANT.id}`, OWNER, {
      'GET /support-requests': () => json([ACTIVE_GRANT, ENDED]),
      'GET /support-requests/:id/activity': () =>
        json([
          { at: '2026-10-01T05:01:00.000Z', method: 'GET', path: '/stock?limit=50' },
          { at: '2026-10-01T05:02:00.000Z', method: 'POST', path: '/parties' },
        ]),
    });
    expect(
      await screen.findByRole('heading', { name: 'Support access by Asha Operator', level: 1 }),
    ).toBeVisible();
    expect(screen.getByText('Access until')).toBeVisible();
    const log = await screen.findByRole('table', { name: 'Requests made with this access' });
    const rows = within(log).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Looked at/stock?limit=50');
    expect(rows[2]).toHaveTextContent('Tried to change/parties');
    await user.click(
      within(screen.getByRole('main')).getByRole('link', { name: 'Support access' }),
    );
    expect(await screen.findByRole('heading', { name: 'Support access', level: 1 })).toBeVisible();
  });

  it('has no log before access was given, and says when the log or request is missing', async () => {
    const view = renderTenant(`/settings/support/${DECLINED.id}`, OWNER, {
      'GET /support-requests': () => json([DECLINED, ENDED]),
    });
    expect(await screen.findByText('Declined', { selector: 'dt' })).toBeVisible();
    expect(screen.queryByText('What support looked at')).toBeNull();
    view.unmount();

    const ended = renderTenant(`/settings/support/${ENDED.id}`, OWNER, {
      'GET /support-requests': () => json([ENDED]),
      'GET /support-requests/:id/activity': () => json([]),
    });
    expect(await screen.findByText('Nothing yet')).toBeVisible();
    ended.unmount();

    const failing = renderTenant(`/settings/support/${ENDED.id}`, OWNER, {
      'GET /support-requests': () => json([ENDED]),
      'GET /support-requests/:id/activity': () => json({ message: 'Database down' }, 503),
    });
    expect(await screen.findByText('Could not load the activity')).toBeVisible();
    failing.unmount();

    renderTenant('/settings/support/unknown', OWNER, {
      'GET /support-requests': () => json([ENDED]),
    });
    expect(
      await screen.findByText('This record does not exist, or you cannot see it.'),
    ).toBeVisible();
  });
});

describe('support banners', () => {
  it('tells owners while support can see the business', async () => {
    renderTenant('/dashboard', OWNER, {
      'GET /support-requests': () => json([grant(), ACTIVE_GRANT]),
    });
    expect(await screen.findByText('Platform support can see your business')).toBeVisible();
    expect(
      screen.getByText('Asha Operator has read-only access until 1 Oct 2026, 11:30 am.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute(
      'href',
      '/settings/support',
    );
  });

  it('tells owners when support asks for access', async () => {
    renderTenant('/dashboard', OWNER, { 'GET /support-requests': () => json([grant(), ENDED]) });
    expect(await screen.findByText('Platform support asks to see your business')).toBeVisible();
    expect(
      screen.getByText('Asha Operator asks for read-only access: Stock report looks wrong'),
    ).toBeVisible();
  });

  it('shows nothing when support is not involved, or to members who do not decide', async () => {
    const view = renderTenant('/dashboard', OWNER, {
      'GET /support-requests': () => json([ENDED]),
    });
    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
    await waitFor(() => {
      expect(view.requests.some((request) => request.path === '/support-requests')).toBe(true);
    });
    expect(screen.queryByText(/Platform support/)).toBeNull();
    view.unmount();

    const cashier = renderTenant('/dashboard', CASHIER, {});
    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
    expect(cashier.requests.some((request) => request.path === '/support-requests')).toBe(false);
  });

  it('marks platform support’s own view as read-only, with when it ends', async () => {
    renderTenant('/dashboard', SUPPORT, {});
    expect(await screen.findByText('Support view – read only')).toBeVisible();
    expect(
      screen.getByText(
        `You are looking at ABC Paints as platform support. Nothing can be changed. Access ends at 1 Jan 2099, 5:30 am.`,
      ),
    ).toBeVisible();
    expect(GRANT.expiresAt).toBe('2099-01-01T00:00:00.000Z');
  });
});

describe('grantLength', () => {
  it('reads whole hours as hours and the rest as minutes', () => {
    const { plural } = createI18n('en');
    expect(grantLength(plural, 60)).toBe('1 hour');
    expect(grantLength(plural, 120)).toBe('2 hours');
    expect(grantLength(plural, 90)).toBe('90 minutes');
  });
});

describe('support view tabs', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('refuses a support link that carries someone’s ordinary session, before showing anything', async () => {
    sessionStorage.setItem(SUPPORT_TAB_KEY, '1');
    const { requests } = renderTenant('/dashboard', OWNER, {});
    expect(
      await screen.findByText(
        'This link isn’t a valid support view, so it was not opened. Sign in with your own account.',
      ),
    ).toBeVisible();
    expect(screen.getByTestId('location').textContent).toBe('/sign-in');
    expect(sessionStorage.getItem(SUPPORT_TAB_KEY)).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    // Nothing of that account was loaded or shown.
    expect(requests.map((request) => request.path)).toEqual(['/auth/me']);
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();
  });

  it('accepts platform support’s own session', async () => {
    sessionStorage.setItem(SUPPORT_TAB_KEY, '1');
    const { requests } = renderTenant('/dashboard', SUPPORT, {});
    expect(await screen.findByText('Support view – read only')).toBeVisible();
    expect(isSupportTab()).toBe(true);
    // A support view keeps the product's own look.
    expect(requests.some((request) => request.path === '/organization/branding')).toBe(false);
  });

  it('marks and unmarks a tab in the storage given', () => {
    const storage = window.localStorage;
    storage.setItem(SUPPORT_TAB_KEY, '1');
    expect(isSupportTab(storage)).toBe(true);
    leaveSupportTab(storage);
    expect(isSupportTab(storage)).toBe(false);
  });
});
