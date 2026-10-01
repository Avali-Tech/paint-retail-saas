import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Notification, NotificationPage } from '../api/types.js';
import { OWNER, json } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { badgeCount } from './NotificationBell.js';

const item = (id: string, readAt: string | null): Notification => ({
  id,
  event: 'transfer_requested',
  title: `Transfer ${id} requested`,
  body: 'Pune asks Hyderabad for 10 × Apex 1 l',
  link: `/transfers/${id}`,
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  readAt,
});

function renderBell(page: () => ReturnType<typeof json> | Promise<ReturnType<typeof json>>) {
  return renderApp({
    path: '/parties',
    routes: {
      'GET /auth/me': () => json(OWNER),
      'GET /notifications': page,
      'POST /notifications/:id/read': () => ({ status: 204 }),
      'POST /notifications/read-all': () => json({ marked: 1 }),
    },
  });
}

describe('badgeCount', () => {
  it('caps the number on the badge', () => {
    expect(badgeCount(3)).toBe('3');
    expect(badgeCount(10)).toBe('9+');
  });
});

describe('NotificationBell', () => {
  it('shows the unread count and the latest notifications', async () => {
    let page: NotificationPage = {
      items: [item('t1', null), item('t2', '2026-10-01T00:00:00Z')],
      total: 2,
      unread: 1,
    };
    const { user, requests } = renderBell(() => json(page));
    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    await user.click(bell);
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(within(panel).getByText('Transfer t1 requested')).toBeInTheDocument();
    expect(within(panel).getAllByText('5 minutes ago')).toHaveLength(2);

    page = {
      ...page,
      items: page.items.map((entry) => ({ ...entry, readAt: '2026-10-01T00:00:00Z' })),
      unread: 0,
    };
    await user.click(within(panel).getByRole('button', { name: 'Mark all as read' }));
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(requests.some((request) => request.path === '/notifications/read-all')).toBe(true);
  });

  it('marks a notification read when it is opened', async () => {
    const { user, requests } = renderBell(() =>
      json({ items: [item('t1', null), item('t2', '2026-10-01T00:00:00Z')], total: 2, unread: 12 }),
    );
    expect(await screen.findByText('9+')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Notifications, 12 unread' }));
    await user.click(await screen.findByRole('link', { name: /Transfer t2/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/transfers/t2');
    await user.click(screen.getByRole('button', { name: /Notifications/ }));
    await user.click(await screen.findByRole('link', { name: /Transfer t1/ }));
    await waitFor(() => {
      expect(
        requests.filter((request) => request.path.endsWith('/read')).map((request) => request.path),
      ).toEqual(['/notifications/t1/read']);
    });
  });

  it('says when there is nothing new, or when they cannot be loaded', async () => {
    const { user } = renderBell(() => json({ items: [], total: 0, unread: 0 }));
    await user.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText('You are all caught up')).toBeInTheDocument();
  });

  it('reports a failure to load', async () => {
    const { user } = renderBell(() => json({ message: 'down' }, 500));
    await user.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText('Could not load notifications')).toBeInTheDocument();
  });

  it('shows progress while loading', async () => {
    const { user } = renderBell(() => new Promise(() => undefined));
    await user.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
  });
});
